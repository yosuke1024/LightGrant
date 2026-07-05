import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { config } from "../config.js";
import { logger } from "../logger.js";

let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = config.DATABASE_PATH;
  const dbDir = path.dirname(dbPath);

  // Ensure parent directories exist
  if (!fs.existsSync(dbDir)) {
    logger.info({ dbDir }, "Creating database directory");
    fs.mkdirSync(dbDir, { recursive: true });
  }

  logger.info({ dbPath }, "Initializing SQLite database");

  try {
    const db = new Database(dbPath);

    // Apply performance and safety pragmas
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");

    dbInstance = db;
    return db;
  } catch (error) {
    logger.fatal({ error, dbPath }, "Failed to initialize database");
    process.exit(1);
  }
}

export function closeDatabase(): void {
  if (dbInstance) {
    logger.info("Closing SQLite database");
    try {
      dbInstance.close();
      dbInstance = null;
    } catch (error) {
      logger.error({ error }, "Error closing database");
    }
  }
}
