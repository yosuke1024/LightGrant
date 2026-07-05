import { Router, Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import { AuditRepository } from "../persistence/repositories/audit-repository.js";
import { logger } from "../logger.js";

export function createAuditRouter(db: Database.Database): Router {
  const router = Router();
  const auditRepo = new AuditRepository(db);

  router.get(
    "/export",
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const token = req.query.token as string;
      if (!token) {
        res.status(400).send("Missing token parameter");
        return;
      }

      try {
        // 1. Resolve token hash
        const tokenHash = crypto
          .createHash("sha256")
          .update(token)
          .digest("hex");

        // 2. Fetch active token details
        const tokenDetails = auditRepo.getExportToken(tokenHash);
        if (!tokenDetails) {
          logger.warn(
            { tokenHash },
            "Audit download rejected: token not found or already used",
          );
          res.status(403).send("Invalid, used, or expired token");
          return;
        }

        // 3. Verify expiration
        const expiresAt = new Date(tokenDetails.expires_at).getTime();
        if (Date.now() > expiresAt) {
          logger.warn({ tokenHash }, "Audit download rejected: token expired");
          res.status(403).send("Token has expired");
          return;
        }

        // Concurrency Check
        const now = new Date();
        const leaseExpiresAtTime = tokenDetails.download_lease_expires_at
          ? new Date(tokenDetails.download_lease_expires_at).getTime()
          : 0;
        
        if (tokenDetails.download_started_at && now.getTime() <= leaseExpiresAtTime) {
          logger.warn(
            { tokenHash },
            "Audit download rejected: Concurrent download in progress",
          );
          res.status(409).send("Conflict: Another download is in progress for this token.");
          return;
        }

        // Acquire Lease (valid for 60 seconds)
        const leaseDurationMs = 60 * 1000;
        const nextLeaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();

        const acquired = db.transaction(() => {
          const result = db.prepare(
            `
            UPDATE export_tokens
            SET download_started_at = ?,
                download_lease_expires_at = ?
            WHERE token_hash = ?
              AND used_at IS NULL
              AND (
                download_lease_expires_at IS NULL
                OR download_lease_expires_at <= ?
              )
            `
          ).run(now.toISOString(), nextLeaseExpiresAt, tokenHash, now.toISOString());
          return result.changes === 1;
        })();

        if (!acquired) {
          res.status(409).send("Conflict: Failed to acquire download lease.");
          return;
        }

        // 4. Verify file exists
        if (!fs.existsSync(tokenDetails.file_path)) {
          logger.error(
            { filePath: tokenDetails.file_path },
            "Audit download error: CSV file missing",
          );
          res.status(404).send("Exported file not found");
          return;
        }

        // 5. Send file and cleanup afterwards
        res.download(
          tokenDetails.file_path,
          "lightgrant_audit_log.csv",
          (err) => {
            if (err) {
              logger.error(
                { err, tokenHash },
                "Error sending audit CSV download response. Releasing lease.",
              );
              db.prepare(
                "UPDATE export_tokens SET download_started_at = NULL, download_lease_expires_at = NULL WHERE token_hash = ?"
              ).run(tokenHash);
            } else {
              logger.info({ tokenHash }, "Audit download completed successfully. Marking used.");
              db.prepare(
                "UPDATE export_tokens SET used_at = ? WHERE token_hash = ?"
              ).run(new Date().toISOString(), tokenHash);

              // Delete temporary CSV file after successful download response
              try {
                fs.unlinkSync(tokenDetails.file_path);
                logger.debug(
                  { filePath: tokenDetails.file_path },
                  "Cleaned up temporary audit CSV file",
                );
              } catch (cleanupErr) {
                logger.warn(
                  { cleanupErr },
                  "Failed to delete temporary CSV file after download",
                );
              }
            }
          },
        );
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
