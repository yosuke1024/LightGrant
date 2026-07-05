import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { runMigrations } from "../../src/persistence/migrations.js";
import { repairZeroOrgIds } from "../../src/services/org-id-repair-service.js";

describe("Database Org ID Repair", () => {
  const tempDbPath = path.resolve("./tests/org-id-repair-test.sqlite");
  let db: Database.Database;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    process.env.DATABASE_PATH = tempDbPath;
    process.env.APP_SECRET = "a".repeat(32);
    process.env.PUBLIC_BASE_URL = "https://example.com";

    db = new Database(tempDbPath);
    runMigrations(db);

    const timestamp = new Date().toISOString();

    // Insert dummy identity link
    db.prepare(
      `
      INSERT INTO identity_links (id, slack_workspace_id, slack_user_id, github_user_id, github_login, linked_at, last_verified_at, created_at, updated_at)
      VALUES ('id-1', 'W123', 'U456', 999, 'octocat', ?, ?, ?, ?)
    `,
    ).run(timestamp, timestamp, timestamp, timestamp);

    db.prepare(
      `
      INSERT INTO grants (id, github_org_id, target_team_id, github_user_id, github_login_snapshot, status, membership_created_by_app, effective_expires_at, created_at, updated_at)
      VALUES ('grant-repair-1', 0, 2222, 999, 'octocat', 'pending', 1, ?, ?, ?)
    `,
    ).run(timestamp, timestamp, timestamp);

    db.prepare(
      `
      INSERT INTO policies (id, slack_workspace_id, github_org_id, target_team_id, status, current_version, created_by_identity_id, created_at, updated_at)
      VALUES ('policy-repair-1', 'W123', 0, 2222, 'active', 1, 'id-1', ?, ?)
    `,
    ).run(timestamp, timestamp);

    db.prepare(
      `
      INSERT INTO access_requests (id, slack_workspace_id, github_org_id, requester_identity_id, target_team_id, duration_minutes, reason, decision_status, requested_at, created_at, updated_at)
      VALUES ('req-repair-1', 'W123', 0, 'id-1', 2222, 60, 'reason', 'pending', ?, ?, ?)
    `,
    ).run(timestamp, timestamp, timestamp);

    db.prepare(
      `
      INSERT INTO audit_events (event_id, event_type, occurred_at, actor_type, github_org_id, correlation_id, payload_json, event_hash, created_at)
      VALUES ('evt-repair-1', 'test.event', ?, 'system', 0, 'corr-1', '{}', 'hash', ?)
    `,
    ).run(timestamp, timestamp);
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  it("should update historical 0 github_org_id records to resolved targetOrgId", () => {
    // Run the repair service function directly
    repairZeroOrgIds(db, 7777);

    // Verify database updates
    const grant = db
      .prepare("SELECT github_org_id FROM grants WHERE id = 'grant-repair-1'")
      .get() as any;
    expect(grant.github_org_id).toBe(7777);

    const policy = db
      .prepare(
        "SELECT github_org_id FROM policies WHERE id = 'policy-repair-1'",
      )
      .get() as any;
    expect(policy.github_org_id).toBe(7777);

    const request = db
      .prepare(
        "SELECT github_org_id FROM access_requests WHERE id = 'req-repair-1'",
      )
      .get() as any;
    expect(request.github_org_id).toBe(7777);

    const audit = db
      .prepare(
        "SELECT github_org_id FROM audit_events WHERE event_id = 'evt-repair-1'",
      )
      .get() as any;
    expect(audit.github_org_id).toBe(7777);
  });
});
