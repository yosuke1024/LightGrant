import { Router, Request, Response, NextFunction } from "express";
import Database from "better-sqlite3";
import crypto from "crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { GitHubOrganizationContext } from "../domain/github-organization-context.js";
import { GitHubAccessProvider } from "../integrations/github/github-client.js";

export function createWebhookRouter(
  db: Database.Database,
  orgContext: GitHubOrganizationContext,
  githubClient: GitHubAccessProvider,
): Router {
  const router = Router();

  const handleWebhook = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
      const signature = req.headers["x-hub-signature-256"] as string;
      const deliveryId = req.headers["x-github-delivery"] as string;
      const eventName = req.headers["x-github-event"] as string;

      if (!deliveryId) {
        res.status(400).send("Missing x-github-delivery header");
        return;
      }

      // 1. Signature Verification
      if (!signature) {
        logger.warn(
          { deliveryId },
          "Webhook rejected: missing signature header",
        );
        res.status(401).send("Missing signature");
        return;
      }

      const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody;
      if (!rawBody) {
        logger.error(
          { deliveryId },
          "Webhook verify failed: rawBody not captured",
        );
        res.status(500).send("Failed to verify signature");
        return;
      }

      const hmac = crypto.createHmac("sha256", config.GITHUB_WEBHOOK_SECRET);
      hmac.update(rawBody);
      const expectedSignature = `sha256=${hmac.digest("hex")}`;

      try {
        const trusted = Buffer.from(expectedSignature, "utf8");
        const untrusted = Buffer.from(signature, "utf8");
        if (
          trusted.length !== untrusted.length ||
          !crypto.timingSafeEqual(trusted, untrusted)
        ) {
          logger.warn({ deliveryId }, "Webhook rejected: signature mismatch");
          res.status(401).send("Invalid signature");
          return;
        }
      } catch (err) {
        logger.error({ err, deliveryId }, "Signature verification exception");
        res.status(401).send("Invalid signature format");
        return;
      }

      // 2. Deduplication (CAS on webhook_deliveries)
      const now = new Date().toISOString();
      const payloadString = JSON.stringify(req.body);

      try {
        // Insert with status = 'received' and store payload_json for reprocessing
        db.prepare(
          `
          INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, payload_json)
          VALUES ('github', ?, ?, ?, 'received', ?)
        `,
        ).run(deliveryId, eventName || "unknown", now, payloadString);
      } catch (err) {
        const sqliteError = err as { code?: string; message?: string };
        if (
          sqliteError.code === "SQLITE_CONSTRAINT" ||
          (sqliteError.message && sqliteError.message.includes("UNIQUE"))
        ) {
          const existing = db.prepare(
            "SELECT status, lease_expires_at FROM webhook_deliveries WHERE provider = 'github' AND delivery_id = ?"
          ).get(deliveryId) as { status: string; lease_expires_at: string | null } | undefined;

          if (existing) {
            if (existing.status === "processed") {
              logger.info(
                { deliveryId },
                "Duplicate webhook delivery detected (already processed). Skipping execution.",
              );
              res.status(200).send("Duplicate delivery skipped");
              return;
            } else if (existing.status === "processing") {
              if (existing.lease_expires_at && existing.lease_expires_at > now) {
                logger.info(
                  { deliveryId },
                  "Webhook delivery is currently processing and lease is active. Skipping.",
                );
                res.status(202).send("Processing");
                return;
              }
              logger.warn(
                { deliveryId },
                "Webhook delivery lease has expired. Recovering and reprocessing.",
              );
            } else {
              logger.info(
                { deliveryId, status: existing.status },
                "Reprocessing existing webhook delivery.",
              );
            }
          } else {
            logger.error({ err, deliveryId }, "Unique constraint error but row not found");
            res.status(500).send("Internal server error");
            return;
          }
        } else {
          logger.error(
            { err, deliveryId },
            "Error registering webhook delivery in DB",
          );
          res.status(500).send("Internal server error");
          return;
        }
      }

      // 3. Process Webhook Event payload using WebhookService
      try {
        const { WebhookService } = await import("../services/webhook-service.js");
        const webhookService = new WebhookService(db, orgContext, githubClient);
        const processed = await webhookService.processDelivery(deliveryId, eventName, req.body);
        
        if (processed) {
          res.status(200).send("Webhook processed successfully");
        } else {
          res.status(500).send("Webhook processing failed or organization mismatch");
        }
      } catch (err) {
        logger.error({ err, deliveryId }, "Error routing Webhook event processing");
        res.status(500).send("Webhook processing failed");
      }
  };

  router.post("/github/webhooks", handleWebhook);
  router.post("/webhooks/github", handleWebhook);

  return router;
}
