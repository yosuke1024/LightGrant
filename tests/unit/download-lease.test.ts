import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { runMigrations } from "../../src/persistence/migrations.js";
import { ReconciliationService } from "../../src/services/reconciliation-service.js";

describe("DownloadLease & Cleanup", () => {
  const tempDbPath = path.resolve("./tests/download-lease-test.sqlite");
  const testExportDir = path.resolve("./data/audit_exports");
  let db: Database.Database;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    if (!fs.existsSync(testExportDir)) {
      fs.mkdirSync(testExportDir, { recursive: true });
    }
    db = new Database(tempDbPath);
    runMigrations(db);
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  beforeEach(() => {
    db.prepare("DELETE FROM export_tokens").run();
  });

  it("should release expired leases and delete expired/used tokens with files", () => {
    const now = new Date();
    const future = new Date(now.getTime() + 600 * 1000).toISOString();
    const past = new Date(now.getTime() - 10 * 1000).toISOString();

    const token1 = crypto.randomBytes(32).toString("hex");
    const tokenHash1 = crypto.createHash("sha256").update(token1).digest("hex");
    const file1 = path.resolve(testExportDir, `test-file-1-${crypto.randomUUID()}.csv`);
    fs.writeFileSync(file1, "data");

    // Case 1: Expired lease (used_at is NULL, download_lease_expires_at is past)
    db.prepare(
      `
      INSERT INTO export_tokens (
        token_hash, slack_workspace_id, slack_user_id, file_path, expires_at, created_at,
        download_started_at, download_lease_expires_at
      ) VALUES (?, 'W', 'U', ?, ?, ?, ?, ?)
      `
    ).run(tokenHash1, file1, future, past, past, past);

    // Case 2: Expired token (expires_at is past)
    const token2 = crypto.randomBytes(32).toString("hex");
    const tokenHash2 = crypto.createHash("sha256").update(token2).digest("hex");
    const file2 = path.resolve(testExportDir, `test-file-2-${crypto.randomUUID()}.csv`);
    fs.writeFileSync(file2, "data");
    db.prepare(
      `
      INSERT INTO export_tokens (
        token_hash, slack_workspace_id, slack_user_id, file_path, expires_at, created_at
      ) VALUES (?, 'W', 'U', ?, ?, ?)
      `
    ).run(tokenHash2, file2, past, past);

    // Create Service using mocks
    const service = new ReconciliationService(
      db,
      {} as any,
      {} as any,
      { organizationId: 1 } as any
    );

    // Execute cleanup via reconcile
    const nowStr = now.toISOString();
    (service as any).cleanupExportTokens(nowStr);

    // Verify Case 1: Lease was released, record still exists, file still exists
    const t1 = db.prepare("SELECT * FROM export_tokens WHERE token_hash = ?").get(tokenHash1) as any;
    expect(t1).toBeDefined();
    expect(t1.download_started_at).toBeNull();
    expect(t1.download_lease_expires_at).toBeNull();
    expect(fs.existsSync(file1)).toBe(true);

    // Verify Case 2: Token and file were deleted
    const t2 = db.prepare("SELECT * FROM export_tokens WHERE token_hash = ?").get(tokenHash2);
    expect(t2).toBeUndefined();
    expect(fs.existsSync(file2)).toBe(false);

    // Clean up file 1
    if (fs.existsSync(file1)) {
      fs.unlinkSync(file1);
    }
  });
});
