import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { logger } from "../logger.js";

// Resolve directory path for migrations
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Migrations are located at the root of the project (../../migrations)
const MIGRATIONS_DIR = path.resolve(__dirname, "../../migrations");

export function runMigrations(db: Database.Database): void {
  logger.info("Running database migrations");

  // 1. Create schema_migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      migrated_at TEXT NOT NULL
    );
  `);

  // 2. Scan migration files
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    logger.info(
      { MIGRATIONS_DIR },
      "Migrations directory does not exist, creating one.",
    );
    fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
    return;
  }

  const files = fs.readdirSync(MIGRATIONS_DIR);
  const migrationFiles = files
    .filter((f) => f.endsWith(".sql"))
    .map((f) => {
      const match = f.match(/^(\d+)_(.+)\.sql$/);
      if (!match) {
        logger.warn(
          { filename: f },
          "Invalid migration filename format, skipping",
        );
        return null;
      }
      return {
        filename: f,
        version: parseInt(match[1], 10),
        name: match[2],
      };
    })
    .filter((m): m is Exclude<typeof m, null> => m !== null)
    .sort((a, b) => a.version - b.version);

  // 3. Get applied migrations
  const stmt = db.prepare("SELECT version FROM schema_migrations");
  const rows = stmt.all() as { version: number }[];
  const appliedVersions = new Set(rows.map((r) => r.version));

  // 4. Run pending migrations in a transaction
  for (const migration of migrationFiles) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }

    logger.info(
      { version: migration.version, name: migration.name },
      "Applying migration",
    );

    const filePath = path.join(MIGRATIONS_DIR, migration.filename);
    const sql = fs.readFileSync(filePath, "utf8");

    // Run transaction
    const runTx = db.transaction(() => {
      // Execute the migration SQL
      db.exec(sql);
      // Record in schema_migrations
      const insertStmt = db.prepare(
        "INSERT INTO schema_migrations (version, migrated_at) VALUES (?, ?)",
      );
      insertStmt.run(migration.version, new Date().toISOString());
    });

    try {
      runTx();
      logger.info(
        { version: migration.version },
        "Migration applied successfully",
      );
    } catch (error) {
      logger.fatal(
        { version: migration.version, error },
        "Migration failed. Exiting.",
      );
      process.exit(1);
    }
  }

  logger.info("Database migrations completed");
}
