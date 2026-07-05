import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { PolicyRepository } from "../../src/persistence/repositories/policy-repository.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import { createTestPolicy } from "../helpers/create-test-policy.js";

describe("PolicyRepository", () => {
  const tempDbPath = path.resolve("./tests/policy-repo-test.sqlite");
  let db: Database.Database;
  let repository: PolicyRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    repository = new PolicyRepository(db);
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
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM policies").run();
    db.prepare("DELETE FROM policy_versions").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should create and retrieve active policy with highest version", () => {
    const timestamp = new Date().toISOString();

    // Seed creator identity link
    db.prepare(
      `
      INSERT INTO identity_links (
        id, slack_workspace_id, slack_user_id, github_user_id, github_login, linked_at, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "id-creator",
      "W123",
      "U-creator",
      999,
      "creator-git",
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    );

    createTestPolicy(db, {
      id: "pol-1",
      version: 1,
      target_team_id: 101,
      max_duration_minutes: 60,
      snapshot_json: JSON.stringify({ allowed_slack_channel_ids: ["C111"] }),
      slack_workspace_id: "W123",
      github_org_id: 1111,
      created_by_identity_id: "id-creator",
    });

    createTestPolicy(db, {
      id: "pol-2",
      version: 2,
      target_team_id: 101,
      max_duration_minutes: 120,
      snapshot_json: JSON.stringify({ allowed_slack_channel_ids: ["C111"] }),
      slack_workspace_id: "W123",
      github_org_id: 1111,
      created_by_identity_id: "id-creator",
    });

    createTestPolicy(db, {
      id: "pol-3",
      version: 3,
      target_team_id: 101,
      max_duration_minutes: 240,
      snapshot_json: JSON.stringify({ allowed_slack_channel_ids: ["C111"] }),
      slack_workspace_id: "W123",
      github_org_id: 1111,
      created_by_identity_id: "id-creator",
    });
    db.prepare(
      "UPDATE policies SET status = 'disabled', disabled_at = ? WHERE id = ?",
    ).run(timestamp, "pol-3");

    const activeList = repository.listActivePoliciesForTeam(101);
    expect(activeList).toHaveLength(2);
    const ids = activeList.map((p) => p.id);
    expect(ids).toContain("pol-1");
    expect(ids).toContain("pol-2");
    expect(ids).not.toContain("pol-3");

    const nonExistent = repository.listActivePoliciesForTeam(999);
    expect(nonExistent).toHaveLength(0);
  });
});
