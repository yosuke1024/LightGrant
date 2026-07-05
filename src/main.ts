import { config } from "./config.js";
import { logger } from "./logger.js";
import { getDatabase, closeDatabase } from "./persistence/database.js";
import { runMigrations } from "./persistence/migrations.js";
import { createServer } from "./http/server.js";
import { healthState } from "./http/health-routes.js";
import { AccessScheduler } from "./services/scheduler.js";
import { GitHubClient } from "./integrations/github/github-client.js";
import { SlackNotifierService } from "./services/slack-notifier.js";
import { JobWorker } from "./workers/job-worker.js";
import { RevocationService } from "./services/revocation-service.js";
import { ReconciliationService } from "./services/reconciliation-service.js";
import { Server } from "http";
import { GitHubOrganizationContext } from "./domain/github-organization-context.js";

let server: Server | null = null;
let scheduler: AccessScheduler | null = null;
let jobWorker: JobWorker | null = null;

async function bootstrap() {
  logger.info("Starting LightGrant application initialization...");

  try {
    // 1. Initialize Database
    const db = getDatabase();
    healthState.isDatabaseReady = true;

    // 2. Run migrations
    runMigrations(db);
    healthState.isMigrationsReady = true;

    // 3. Start Auto-Revocation Scheduler
    const githubClient = new GitHubClient({
      appId: config.GITHUB_APP_ID,
      privateKey: config.GITHUB_PRIVATE_KEY_BASE64,
      clientId: config.GITHUB_CLIENT_ID,
      clientSecret: config.GITHUB_CLIENT_SECRET,
      org: config.GITHUB_ORG,
    });

    let targetOrgId = 0;
    let orgContext: GitHubOrganizationContext;
    try {
      const inst = await githubClient.resolveInstallation();
      targetOrgId = inst.targetId;
      logger.info(
        { targetOrgId },
        "Resolved live GitHub Organization ID from installation",
      );

      orgContext = {
        organizationId: inst.targetId,
        organizationLogin: inst.accountLogin,
        installationId: inst.id,
      };
    } catch (err) {
      logger.fatal(
        { err },
        "Failed to resolve live GitHub Organization ID during startup. Fail-Fast.",
      );
      throw err;
    }

    const { repairZeroOrgIds } =
      await import("./services/org-id-repair-service.js");
    repairZeroOrgIds(db, targetOrgId);

    const notifier = new SlackNotifierService();
    const revocationService = new RevocationService(db, githubClient, notifier);
    const reconciliationService = new ReconciliationService(
      db,
      githubClient,
      revocationService,
      orgContext,
    );

    // Perform immediate reconciliation synchronization on startup
    await reconciliationService.reconcile();

    scheduler = new AccessScheduler(reconciliationService);
    scheduler.start((config.REVOCATION_POLL_INTERVAL_SECONDS || 30) * 1000);

    // 4. Start Job Worker
    jobWorker = new JobWorker(db, githubClient, notifier, orgContext);
    jobWorker.start();
    healthState.isWorkersReady = true;

    // 4. Start HTTP Server
    const app = createServer(orgContext, githubClient);
    server = app.listen(config.PORT, () => {
      logger.info(
        {
          port: config.PORT,
          env: config.NODE_ENV,
          baseUrl: config.PUBLIC_BASE_URL,
        },
        "LightGrant HTTP server successfully started",
      );
    });

    // Handle startup completion
    logger.info("LightGrant initialization successfully completed");
  } catch (error) {
    logger.fatal({ error }, "LightGrant failed to bootstrap. Exiting.");
    process.exit(1);
  }
}

// Graceful shutdown handling
function shutdown(signal: string) {
  logger.info(
    { signal },
    "Graceful shutdown signal received. Starting cleanup...",
  );

  // Set health states to false to fail readiness checks during shutdown
  healthState.isDatabaseReady = false;
  healthState.isWorkersReady = false;

  if (scheduler) {
    scheduler.stop();
  }

  if (jobWorker) {
    jobWorker.stop();
  }

  if (server) {
    logger.info("Closing HTTP server...");
    server.close((err) => {
      if (err) {
        logger.error({ err }, "Error during HTTP server close");
      } else {
        logger.info("HTTP server closed");
      }

      // Close DB after HTTP server has stopped accepting new connections
      closeDatabase();
      logger.info("Graceful shutdown completed. Exiting.");
      process.exit(0);
    });

    // Force exit after 10 seconds if graceful shutdown hangs
    setTimeout(() => {
      logger.error("Graceful shutdown timed out. Forcing exit.");
      closeDatabase();
      process.exit(1);
    }, 10000).unref();
  } else {
    closeDatabase();
    logger.info("Graceful shutdown completed without active server. Exiting.");
    process.exit(0);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Handle uncaught exceptions and unhandled rejections
process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception occurred");
  shutdown("UNCAUGHT_EXCEPTION");
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "Unhandled promise rejection occurred");
  shutdown("UNHANDLED_REJECTION");
});

bootstrap();
