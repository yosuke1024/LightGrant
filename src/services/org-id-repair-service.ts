import Database from "better-sqlite3";
import { logger } from "../logger.js";

/**
 * Repairs database records with historical github_org_id = 0.
 * Updates them to the resolved targetOrgId.
 */
export function repairZeroOrgIds(
  db: Database.Database,
  targetOrgId: number,
): void {
  if (targetOrgId <= 0) return;

  db.transaction(() => {
    const tables = ["grants", "policies", "access_requests", "audit_events"];
    for (const table of tables) {
      const stmt = db.prepare(
        `UPDATE ${table} SET github_org_id = ? WHERE github_org_id = 0`,
      );
      const result = stmt.run(targetOrgId);
      if (result.changes > 0) {
        logger.info(
          { table, count: result.changes, targetOrgId },
          `Repaired historical ${table} records with 0 github_org_id`,
        );
      }
    }
  })();
}
