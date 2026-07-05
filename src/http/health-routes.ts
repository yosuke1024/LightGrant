import { Router } from "express";
import { getDatabase } from "../persistence/database.js";
import { logger } from "../logger.js";

export const healthRouter = Router();

export const healthState: {
  isDatabaseReady: boolean;
  isMigrationsReady: boolean;
  isWorkersReady: boolean;
  githubError: string | null;
} = {
  isDatabaseReady: false,
  isMigrationsReady: false,
  isWorkersReady: false,
  githubError: null,
};

healthRouter.get("/healthz", (req, res) => {
  res.status(200).json({ status: "OK" });
});

healthRouter.get("/readyz", (req, res) => {
  // Check if database connection is functional
  let dbOk = false;
  try {
    const db = getDatabase();
    // Simple query to ensure database is responsive
    const row = db.prepare("SELECT 1").get();
    if (row) {
      dbOk = true;
    }
  } catch (error) {
    logger.error({ error }, "Database connectivity check failed for readyz");
  }

  const isReady =
    dbOk && healthState.isMigrationsReady && healthState.isWorkersReady;

  if (isReady) {
    res.status(200).json({
      status: "READY",
      checks: {
        database: dbOk,
        migrations: healthState.isMigrationsReady,
        workers: healthState.isWorkersReady,
      },
    });
  } else {
    res.status(503).json({
      status: "NOT_READY",
      checks: {
        database: dbOk,
        migrations: healthState.isMigrationsReady,
        workers: healthState.isWorkersReady,
      },
    });
  }
});
