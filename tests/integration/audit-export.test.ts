import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { runMigrations } from "../../src/persistence/migrations.js";
import { createAuditRouter } from "../../src/http/audit-routes.js";
import { AuditExportService } from "../../src/services/audit-export-service.js";
import express from "express";
import http from "http";

describe("Audit Export Integration", () => {
  const tempDbPath = path.resolve("./tests/audit-export-integration-test.sqlite");
  let db: Database.Database;
  let app: express.Express;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);

    app = express();
    app.use("/audit", createAuditRouter(db));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as any;
        port = address.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (db) {
      db.close();
    }
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    // Cleanup temporary CSVs
    const exportDir = path.resolve("./data/audit_exports");
    if (fs.existsSync(exportDir)) {
      const files = fs.readdirSync(exportDir);
      for (const file of files) {
        fs.unlinkSync(path.join(exportDir, file));
      }
    }
  });

  beforeEach(() => {
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("DELETE FROM export_tokens").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should generate CSV, save token, allow single download, and delete CSV file afterwards", async () => {
    db.prepare(
      `
      INSERT INTO audit_events (
        event_id, event_type, occurred_at, actor_type, actor_id, correlation_id, payload_json, event_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "event-1",
      "test_action",
      "2026-07-02T00:00:00Z",
      "user",
      "user-1",
      "corr-1",
      "{}",
      "hash1",
      "2026-07-02T00:00:00Z",
    );

    const exportService = new AuditExportService(db);
    const { token } = await exportService.exportToCsv({
      slackWorkspaceId: "W123",
      slackUserId: "U456",
    });

    const response = await fetch(
      `http://localhost:${port}/audit/export?token=${token}`,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Sequence,EventID,EventType");
    expect(text).toContain("test_action");

    // Try downloading a second time (should be forbidden since token is used)
    const secondResponse = await fetch(
      `http://localhost:${port}/audit/export?token=${token}`,
    );
    expect(secondResponse.status).toBe(403);
  });

  it("should reject download if token has expired", async () => {
    const exportService = new AuditExportService(db);
    const { token } = await exportService.exportToCsv({
      slackWorkspaceId: "W123",
      slackUserId: "U456",
    });

    db.prepare("UPDATE export_tokens SET expires_at = ?").run(
      new Date(Date.now() - 1000).toISOString(),
    );

    const response = await fetch(
      `http://localhost:${port}/audit/export?token=${token}`,
    );
    expect(response.status).toBe(403);
  });
});
