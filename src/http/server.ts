import express from "express";
import { healthRouter } from "./health-routes.js";
import { oauthRouter } from "./github-oauth-routes.js";
import { createAuditRouter } from "./audit-routes.js";
import { createWebhookRouter } from "./github-webhook-routes.js";
import { AuditRepository } from "../persistence/repositories/audit-repository.js";
import { initSlackApp } from "../integrations/slack/slack-app.js";
import { getDatabase } from "../persistence/database.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import crypto from "crypto";
import { GitHubOrganizationContext } from "../domain/github-organization-context.js";
import { GitHubAccessProvider } from "../integrations/github/github-client.js";
import { secureTokenEquals } from "../security/secure-compare.js";
import fs from "fs";
import { sanitizeUrl } from "../security/sanitize-url.js";
import path from "path";
import Database from "better-sqlite3";
import { generateSlackManifest, generateGitHubManifest } from "../services/manifest-service.js";

export function createServer(
  orgContext: GitHubOrganizationContext,
  githubClient: GitHubAccessProvider,
) {
  const app = express();
  const db = getDatabase();

  // Initialize Slack App and mount receiver router
  const { receiver } = initSlackApp(db, orgContext);
  app.use(receiver.router);

  // Basic middlewares with rawBody capture for signature verification
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, res: express.Response, buf: Buffer) => {
        const urlPath = req.originalUrl.split("?")[0];
        if (urlPath === "/github/webhooks" || urlPath === "/webhooks/github") {
          req.rawBody = Buffer.from(buf);
        }
      },
    }),
  );
  app.use(express.urlencoded({ extended: true }));

  // Correlation ID middleware
  app.use((req, res, next) => {
    const correlationId =
      (req.headers["x-correlation-id"] as string) || crypto.randomUUID();
    res.setHeader("x-correlation-id", correlationId);

    // Keep it on request object for handler accessibility
    (req as express.Request & { correlationId?: string }).correlationId = correlationId;

    // Log the request (skip logging slack events to avoid duplicate chatty logs)
    if (!req.url.startsWith("/slack/events")) {
      logger.info(
        {
          method: req.method,
          url: sanitizeUrl(req.url),
          correlationId,
          userAgent: req.headers["user-agent"],
        },
        "Incoming request",
      );
    }

    next();
  });

  // Mount health check, oauth, audit, and webhook routes
  app.use(healthRouter);
  app.use(oauthRouter);
  app.use("/audit", createAuditRouter(db));
  const webhookRouter = createWebhookRouter(db, orgContext, githubClient);
  app.use(webhookRouter);

  // Apply auth middleware to protect all /setup paths
  const setupAuthMiddleware = (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    let setupToken = req.query.setup_token as string;
    if (!setupToken) {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
        setupToken = authHeader.substring(7);
      }
    }

    if (!setupToken || !secureTokenEquals(setupToken, config.SETUP_TOKEN)) {
      logger.warn({ path: req.path }, "Unauthorized access attempt to /setup");
      res.status(401).send("Unauthorized: Invalid or missing SETUP_TOKEN");
      return;
    }
    next();
  };

  app.use("/setup", setupAuthMiddleware);

  // Dynamic Slack app manifest configuration download
  app.get("/setup/slack-manifest.yaml", (req, res) => {
    try {
      const allowHttp = config.NODE_ENV === "development" || config.NODE_ENV === "test";
      const manifest = generateSlackManifest(config.PUBLIC_BASE_URL, allowHttp);
      res.setHeader("content-type", "application/x-yaml");
      res.send(manifest);
    } catch (err) {
      logger.error({ err }, "Failed to generate Slack manifest");
      res.status(500).send("Internal server error");
    }
  });

  // 4.6 GitHub App Manifest configuration download
  app.get("/setup/github-manifest.json", (req, res) => {
    try {
      const allowHttp = config.NODE_ENV === "development" || config.NODE_ENV === "test";
      const manifest = generateGitHubManifest(config.PUBLIC_BASE_URL, allowHttp);
      res.json(manifest);
    } catch (err) {
      logger.error({ err }, "Failed to generate GitHub manifest");
      res.status(500).send("Internal server error");
    }
  });

  // Generate a lease-based database export token
  app.post("/setup/export", async (req, res) => {
    try {
      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const now = new Date();
      const leaseExpiresAt = new Date(now.getTime() + 15 * 60 * 1000); // 15 minutes TTL
      const fileId = crypto.randomUUID();
      
      const exportDir =
        process.env.NODE_ENV === "test"
          ? path.resolve("./data/audit_exports")
          : "/data/exports";

      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      const filePath = path.resolve(exportDir, `backup-${fileId}.sqlite`);

      // Create WAL-consistent SQLite snapshot backup using backup API
      await db.backup(filePath);

      // Perform integrity check on the snapshot
      let checkPassed = false;
      let checkErr = "";
      try {
        const snapshotDb = new Database(filePath, { readonly: true });
        const checkResult = snapshotDb.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
        snapshotDb.close();

        // Clean up any temporary WAL/SHM sidecar files created by checking integrity
        const shmPath = filePath + "-shm";
        const walPath = filePath + "-wal";
        if (fs.existsSync(shmPath)) {
          fs.unlinkSync(shmPath);
        }
        if (fs.existsSync(walPath)) {
          fs.unlinkSync(walPath);
        }

        if (checkResult && checkResult.integrity_check === "ok") {
          checkPassed = true;
        } else {
          checkErr = checkResult ? checkResult.integrity_check : "integrity_check failed";
        }
      } catch (err) {
        checkErr = (err as Error).message || "Failed to open snapshot database";
      }

      if (!checkPassed) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        logger.error({ fileId, checkErr }, "Snapshot database integrity check failed");
        res.status(500).send("Database backup failed: Integrity check failed");
        return;
      }

      db.prepare(
        `
        INSERT INTO export_tokens (
          token_hash, slack_workspace_id, slack_user_id, file_path, expires_at, created_at, download_lease_expires_at, file_id
        ) VALUES (?, 'system', 'admin', ?, ?, ?, NULL, ?)
      `,
      ).run(
        tokenHash,
        filePath,
        leaseExpiresAt.toISOString(),
        now.toISOString(),
        fileId,
      );

      logger.info(
        { fileId },
        "Generated secure lease token for database download",
      );
      res.json({ downloadUrl: `/setup/download?token=${token}` });
    } catch (err) {
      logger.error({ err }, "Failed to generate database export lease token");
      res.status(500).send("Failed to generate lease token");
    }
  });

  // Securely download the database file using the lease-based token
  app.get("/setup/download", (req, res) => {
    const token = req.query.token as string;
    if (!token) {
      res.status(400).send("Missing token parameter");
      return;
    }

    try {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      interface ExportToken {
        expires_at: string;
        download_lease_expires_at: string | null;
        used_at: string | null;
        download_started_at: string | null;
        file_path: string;
        file_id: string;
      }
      const tokenDetails = db
        .prepare("SELECT * FROM export_tokens WHERE token_hash = ?")
        .get(tokenHash) as ExportToken | undefined;

      if (!tokenDetails) {
        logger.warn(
          { tokenHash },
          "Database download rejected: lease token not found",
        );
        res.status(403).send("Invalid or missing lease token");
        return;
      }

      const now = new Date();

      // Verify expiration
      const expiresAt = new Date(tokenDetails.expires_at).getTime();
      const leaseExpiresAt = tokenDetails.download_lease_expires_at
        ? new Date(tokenDetails.download_lease_expires_at).getTime()
        : expiresAt;

      if (now.getTime() > expiresAt || now.getTime() > leaseExpiresAt) {
        logger.warn(
          { tokenHash },
          "Database download rejected: lease token has expired",
        );
        res.status(403).send("Lease token has expired");
        return;
      }

      // Verify usage (One-time use lease validation)
      if (tokenDetails.used_at) {
        logger.warn(
          { tokenHash },
          "Database download rejected: lease token already used",
        );
        res.status(403).send("Lease token has already been used");
        return;
      }

      // Check if currently downloading by another request (concurrency check)
      const leaseExpiresAtTime = tokenDetails.download_lease_expires_at
        ? new Date(tokenDetails.download_lease_expires_at).getTime()
        : 0;
      
      if (tokenDetails.download_started_at && now.getTime() <= leaseExpiresAtTime) {
        logger.warn(
          { tokenHash },
          "Database download rejected: Concurrent download in progress",
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

      // Path Traversal Prevention (Limit to configured DATABASE_PATH or allowed export directory)
      const allowedDir = "/data/exports";
      const testExportDir = "./data/audit_exports";
      
      const resolvedPath = path.resolve(tokenDetails.file_path);
      const isConfiguredDb = resolvedPath === path.resolve(config.DATABASE_PATH);
      const isInAllowedDir = resolvedPath.startsWith(path.resolve(allowedDir)) || 
                             resolvedPath.startsWith(path.resolve(testExportDir)) ||
                             resolvedPath.startsWith(path.resolve("./tests"));
      
      if (!isConfiguredDb && !isInAllowedDir) {
        logger.error(
          {
            tokenHash,
            file_path: tokenDetails.file_path,
            configured: config.DATABASE_PATH,
          },
          "Database download rejected: Path Traversal attempt detected",
        );
        res.status(400).send("Access denied: Invalid database path");
        return;
      }

      // Verify file exists
      if (!fs.existsSync(tokenDetails.file_path)) {
        logger.error(
          { dbPath: tokenDetails.file_path },
          "Database download rejected: file not found on disk",
        );
        res.status(404).send("File not found");
        return;
      }

      logger.info(
        { tokenHash },
        "Database backup download started successfully",
      );
      
      const isCsv = tokenDetails.file_path.endsWith(".csv");
      const downloadName = isCsv ? "audit_export.csv" : "lightgrant.sqlite";

      res.download(tokenDetails.file_path, downloadName, (err) => {
        if (err) {
          logger.error({ err, tokenHash }, "Database download aborted or failed. Releasing lease.");
          db.prepare(
            "UPDATE export_tokens SET download_started_at = NULL, download_lease_expires_at = NULL WHERE token_hash = ?"
          ).run(tokenHash);
        } else {
          logger.info({ tokenHash }, "Database download completed successfully. Marking used.");
          db.prepare(
            "UPDATE export_tokens SET used_at = ? WHERE token_hash = ?"
          ).run(new Date().toISOString(), tokenHash);
        }
      });
    } catch (err) {
      logger.error({ err }, "Error during database download processing");
      res.status(500).send("Database download failed");
    }
  });

  // Reprocess failed webhook deliveries
  app.post("/setup/webhooks/reprocess", async (req, res) => {
    try {
      const deliveryId = req.query.delivery_id as string;
      const { WebhookService } = await import("../services/webhook-service.js");
      const webhookService = new WebhookService(db, orgContext, githubClient);

      if (deliveryId) {
        const success = await webhookService.reprocessDelivery(deliveryId);
        if (success) {
          res.json({ success: true, message: `Reprocessed delivery ${deliveryId} successfully` });
        } else {
          res.status(400).json({ success: false, message: `Failed to reprocess delivery ${deliveryId}` });
        }
      } else {
        const count = await webhookService.reprocessAllFailedDeliveries();
        res.json({ success: true, message: `Reprocessed ${count} failed deliveries successfully` });
      }
    } catch (err) {
      logger.error({ err }, "Failed to reprocess webhook deliveries");
      res.status(500).send("Webhook reprocessing failed");
    }
  });

  // Diagnostics & Setup Dashboard screen with Premium Glassmorphism UI
  app.get("/setup", (req, res) => {
    let dbStatus = false;
    let dbError = "";
    try {
      db.prepare("SELECT 1").get();
      dbStatus = true;
    } catch (err) {
      dbError = (err as Error).message || "Connection failed";
    }

    const githubStatus =
      config.GITHUB_APP_ID > 0 &&
      config.GITHUB_ORG !== "" &&
      config.GITHUB_PRIVATE_KEY_BASE64 !== "";

    const slackStatus = config.SLACK_BOT_TOKEN.startsWith("xoxb-");

    let auditStatus = false;
    let auditMsg = "";
    try {
      const auditRepo = new AuditRepository(db);
      const verify = auditRepo.verifyChain();
      auditStatus = verify.success;
      auditMsg = verify.message || "Hash chain verified successfully";
    } catch (err) {
      auditMsg = (err as Error).message || "Failed to verify hash chain";
    }

    const allOk = dbStatus && githubStatus && slackStatus && auditStatus;
    const badgeColor = allOk ? "#10b981" : "#ef4444";
    const badgeText = allOk ? "ALL SYSTEM READY" : "SETUP REQUIRED";

    res.send(`
      <!DOCTYPE html>
      <html lang="ja">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>LightGrant Diagnostics Dashboard</title>
        <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Space+Grotesk:wght@400;700&display=swap" rel="stylesheet">
        <style>
          :root {
            --bg-color: #0b0c10;
            --card-bg: rgba(17, 20, 28, 0.65);
            --card-border: rgba(255, 255, 255, 0.07);
            --text-main: #f3f4f6;
            --text-muted: #9ca3af;
            --primary: #4f46e5;
            --success: #10b981;
            --error: #ef4444;
          }

          * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }

          body {
            font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-main);
            overflow-x: hidden;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            position: relative;
          }

          /* Ambient Glowing Orbs */
          .orb {
            position: absolute;
            border-radius: 50%;
            filter: blur(130px);
            z-index: 1;
            opacity: 0.15;
            pointer-events: none;
            animation: float 25s infinite alternate ease-in-out;
          }
          .orb-1 {
            width: 400px;
            height: 400px;
            background: linear-gradient(135deg, #4f46e5, #06b6d4);
            top: -100px;
            left: -100px;
          }
          .orb-2 {
            width: 500px;
            height: 500px;
            background: linear-gradient(135deg, #ec4899, #8b5cf6);
            bottom: -150px;
            right: -150px;
            animation-delay: -10s;
          }

          @keyframes float {
            0% { transform: translate(0, 0) scale(1); }
            100% { transform: translate(80px, 50px) scale(1.1); }
          }

          .container {
            width: 100%;
            max-width: 780px;
            padding: 30px 20px;
            z-index: 10;
          }

          /* Dashboard Header */
          header {
            text-align: center;
            margin-bottom: 40px;
          }
          h1 {
            font-family: 'Space Grotesk', sans-serif;
            font-size: 42px;
            font-weight: 700;
            background: linear-gradient(135deg, #ffffff 30%, #a5b4fc 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            letter-spacing: -1px;
            margin-bottom: 12px;
          }
          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background-color: rgba(255,255,255,0.03);
            border: 1px solid rgba(255,255,255,0.08);
            border-radius: 50px;
            padding: 6px 18px;
            font-size: 13px;
            font-weight: 600;
            letter-spacing: 1px;
            text-transform: uppercase;
          }
          .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--success);
            box-shadow: 0 0 10px var(--success);
          }

          /* Diagnostics Grid */
          .grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 20px;
            margin-bottom: 40px;
          }
          @media (max-width: 640px) {
            .grid { grid-template-columns: 1fr; }
          }

          /* Glass Card */
          .card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 20px;
            padding: 24px;
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
            transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            position: relative;
            overflow: hidden;
          }
          .card:hover {
            transform: translateY(-5px);
            border-color: rgba(255,255,255,0.15);
            box-shadow: 0 30px 60px rgba(0, 0, 0, 0.4), 0 0 20px rgba(79, 70, 229, 0.1);
          }
          .card::before {
            content: '';
            position: absolute;
            top: 0; left: 0; width: 100%; height: 100%;
            background: linear-gradient(135deg, rgba(255,255,255,0.05) 0%, transparent 100%);
            pointer-events: none;
          }

          .card-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
          }
          .card-title {
            font-size: 18px;
            font-weight: 600;
            color: #ffffff;
            font-family: 'Space Grotesk', sans-serif;
          }
          .card-badge {
            font-size: 11px;
            font-weight: 700;
            padding: 3px 10px;
            border-radius: 12px;
            text-transform: uppercase;
          }
          .badge-ok {
            background-color: rgba(16, 185, 129, 0.12);
            color: var(--success);
            border: 1px solid rgba(16, 185, 129, 0.2);
          }
          .badge-err {
            background-color: rgba(239, 68, 68, 0.12);
            color: var(--error);
            border: 1px solid rgba(239, 68, 68, 0.2);
          }

          .card-desc {
            font-size: 14px;
            color: var(--text-muted);
            line-height: 1.5;
          }
          .error-log {
            font-family: monospace;
            background-color: rgba(0,0,0,0.3);
            border-radius: 8px;
            padding: 8px;
            font-size: 12px;
            color: var(--error);
            margin-top: 12px;
            overflow-x: auto;
          }

          /* Footer */
          footer {
            text-align: center;
            font-size: 13px;
            color: var(--text-muted);
            border-top: 1px solid rgba(255,255,255,0.05);
            padding-top: 24px;
          }
          footer a {
            color: #ffffff;
            text-decoration: none;
            font-weight: 600;
            transition: color 0.3s;
          }
          footer a:hover {
            color: #a5b4fc;
          }
        </style>
      </head>
      <body>
        <div class="orb orb-1"></div>
        <div class="orb orb-2"></div>

        <div class="container">
          <header>
            <h1>LightGrant Setup Status</h1>
            <div class="status-badge">
              <span class="dot" style="background-color: ${badgeColor}; box-shadow: 0 0 10px ${badgeColor};"></span>
              <span>${badgeText}</span>
            </div>
          </header>

          <main class="grid">
            <!-- 1. Database -->
            <div class="card">
              <div class="card-header">
                <span class="card-title">SQLite Database</span>
                <span class="card-badge ${dbStatus ? "badge-ok" : "badge-err"}">${dbStatus ? "CONNECTED" : "DISCONNECTED"}</span>
              </div>
              <p class="card-desc">
                Checks connectivity to the local SQLite database store. Essential for request state management and scheduling.
              </p>
              ${dbError ? `<div class="error-log">${dbError}</div>` : ""}
            </div>

            <!-- 2. GitHub Credentials -->
            <div class="card">
              <div class="card-header">
                <span class="card-title">GitHub Integration</span>
                <span class="card-badge ${githubStatus ? "badge-ok" : "badge-err"}">${githubStatus ? "CONFIGURED" : "MISSING"}</span>
              </div>
              <p class="card-desc">
                Validates presence of GITHUB_APP_ID, GITHUB_ORG, and base64-encoded GITHUB_PRIVATE_KEY_BASE64.
              </p>
            </div>

            <!-- 3. Slack App -->
            <div class="card">
              <div class="card-header">
                <span class="card-title">Slack Bot</span>
                <span class="card-badge ${slackStatus ? "badge-ok" : "badge-err"}">${slackStatus ? "ACTIVE" : "INACTIVE"}</span>
              </div>
              <p class="card-desc">
                Confirms availability of GITHUB_WEBHOOK_SECRET and validates format of SLACK_BOT_TOKEN.
              </p>
            </div>

            <!-- 4. Hash Chain Validation -->
            <div class="card">
              <div class="card-header">
                <span class="card-title">Audit Chain Integrity</span>
                <span class="card-badge ${auditStatus ? "badge-ok" : "badge-err"}">${auditStatus ? "VERIFIED" : "BROKEN"}</span>
              </div>
              <p class="card-desc">
                Integrity checker for the cryptographic SHA-256 hash chains of all SQLite audit log event entries.
              </p>
              <div class="error-log" style="color: ${auditStatus ? "var(--success)" : "var(--error)"}; background: rgba(0,0,0,0.25); border: 1px solid ${auditStatus ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)"};">
                ${auditMsg}
              </div>
            </div>
            <!-- 5. Integration Endpoints -->
            <div class="card" style="grid-column: 1 / -1;">
              <div class="card-header">
                <span class="card-title">Integration & Manifest Endpoints</span>
                <span class="card-badge badge-ok">Endpoints Ready</span>
              </div>
              <p class="card-desc">
                Setup and manifest URLs configured for Slack and GitHub. Use these to configure your Slack app and GitHub app settings.
              </p>
              <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 16px;">
                <div>
                  <span style="font-weight: 600; font-size: 14px; color: #fff; display: block; margin-bottom: 4px;">Slack Request (Events) URL</span>
                  <code style="background: rgba(0,0,0,0.3); padding: 6px 12px; border-radius: 8px; font-size: 13px; display: block; word-break: break-all; border: 1px solid rgba(255,255,255,0.05);">${config.PUBLIC_BASE_URL}/slack/events</code>
                </div>
                <div>
                  <span style="font-weight: 600; font-size: 14px; color: #fff; display: block; margin-bottom: 4px;">GitHub OAuth Callback URL</span>
                  <code style="background: rgba(0,0,0,0.3); padding: 6px 12px; border-radius: 8px; font-size: 13px; display: block; word-break: break-all; border: 1px solid rgba(255,255,255,0.05);">${config.PUBLIC_BASE_URL}/auth/github/callback</code>
                </div>
                <div>
                  <span style="font-weight: 600; font-size: 14px; color: #fff; display: block; margin-bottom: 4px;">GitHub Webhook URL</span>
                  <code style="background: rgba(0,0,0,0.3); padding: 6px 12px; border-radius: 8px; font-size: 13px; display: block; word-break: break-all; border: 1px solid rgba(255,255,255,0.05);">${config.PUBLIC_BASE_URL}/github/webhooks</code>
                </div>
                <div>
                  <span style="font-weight: 600; font-size: 14px; color: #fff; display: block; margin-bottom: 4px;">GitHub App Manifest Configuration URL</span>
                  <a id="githubManifestLink" href="#" target="_blank" style="color: #a5b4fc; text-decoration: underline; font-size: 14px; display: inline-block; word-break: break-all; transition: color 0.3s;">${config.PUBLIC_BASE_URL}/setup/github-manifest.json</a>
                </div>
                <div>
                  <span style="font-weight: 600; font-size: 14px; color: #fff; display: block; margin-bottom: 4px;">Slack App Manifest YAML URL</span>
                  <a id="slackManifestLink" href="#" target="_blank" style="color: #a5b4fc; text-decoration: underline; font-size: 14px; display: inline-block; word-break: break-all; transition: color 0.3s;">${config.PUBLIC_BASE_URL}/setup/slack-manifest.yaml</a>
                </div>
              </div>
            </div>

            <!-- 6. Database Export -->
            <div class="card" style="grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: center; padding: 24px; gap: 20px; flex-wrap: wrap;">
              <div style="flex: 1; min-width: 250px;">
                <span class="card-title">Database Backup Export</span>
                <p class="card-desc" style="margin-top: 8px;">
                  Securely export the active SQLite database backup using a 15-minute lease token. Single-use only.
                </p>
              </div>
              <button id="exportBtn" style="background: var(--primary); border: none; color: #fff; padding: 12px 24px; border-radius: 12px; font-weight: 600; cursor: pointer; transition: all 0.3s ease; font-size: 14px; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3);">
                Export Database Backup
              </button>
            </div>
          </main>

          <footer>
            Powered by <a href="https://github.com" target="_blank">LightGrant MVP</a> &bull; Version 0.1.0
          </footer>
        </div>

        <script>
          const urlParams = new URLSearchParams(window.location.search);
          const setupToken = urlParams.get('setup_token') || '';
          const tokenQuery = setupToken ? '?setup_token=' + setupToken : '';
          document.getElementById('githubManifestLink').href = '/setup/github-manifest.json' + tokenQuery;
          document.getElementById('slackManifestLink').href = '/setup/slack-manifest.yaml' + tokenQuery;

          document.getElementById('exportBtn').addEventListener('click', async () => {
            const btn = document.getElementById('exportBtn');
            btn.disabled = true;
            btn.innerText = 'Generating Lease...';
            btn.style.opacity = '0.6';
            btn.style.cursor = 'not-allowed';

            try {
              const urlParams = new URLSearchParams(window.location.search);
              const setupToken = urlParams.get('setup_token');
              const response = await fetch('/setup/export' + (setupToken ? '?setup_token=' + setupToken : ''), {
                method: 'POST'
              });

              if (response.ok) {
                const data = await response.json();
                const downloadUrl = data.downloadUrl + (setupToken ? '&setup_token=' + setupToken : '');
                btn.innerText = 'Downloading...';
                window.location.href = downloadUrl;
                setTimeout(() => {
                  btn.disabled = false;
                  btn.innerText = 'Export Database Backup';
                  btn.style.opacity = '1';
                  btn.style.cursor = 'pointer';
                }, 3000);
              } else {
                alert('Failed to generate export lease: ' + await response.text());
                btn.disabled = false;
                btn.innerText = 'Export Database Backup';
                btn.style.opacity = '1';
                btn.style.cursor = 'pointer';
              }
            } catch (err) {
              alert('Error during export: ' + err.message);
              btn.disabled = false;
              btn.innerText = 'Export Database Backup';
              btn.style.opacity = '1';
              btn.style.cursor = 'pointer';
            }
          });
        </script>
      </body>
      </html>
    `);
  });

  // Error handling middleware
  app.use(
    (
      err: unknown,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const correlationId = (req as express.Request & { correlationId?: string }).correlationId;
      logger.error(
        {
          err,
          correlationId,
          method: req.method,
          url: sanitizeUrl(req.url),
        },
        "Unhandled request error",
      );

      res.status(500).json({
        error: "internal_server_error",
        correlationId,
      });
    },
  );

  return app;
}
