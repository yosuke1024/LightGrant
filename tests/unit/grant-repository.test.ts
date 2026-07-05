import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import fs from "fs";
import path from "path";

describe("GrantRepository", () => {
  const tempDbPath = path.resolve("./tests/grant-repo-test.sqlite");
  let db: Database.Database;
  let grantRepo: GrantRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    process.env.DATABASE_PATH = tempDbPath;
    db = getDatabase();
    runMigrations(db);
    grantRepo = new GrantRepository(db);
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  beforeEach(() => {
    db.prepare("DELETE FROM grants").run();
  });

  it("should create and retrieve a grant", () => {
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();

    grantRepo.createGrant({
      id: "grant-1",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const grant = grantRepo.getGrant("grant-1");
    expect(grant).not.toBeNull();
    expect(grant?.id).toBe("grant-1");
    expect(grant?.github_org_id).toBe(1111);
    expect(grant?.target_team_id).toBe(2222);
    expect(grant?.github_user_id).toBe(999);
    expect(grant?.github_login_snapshot).toBe("octocat");
    expect(grant?.status).toBe("active");
    expect(grant?.membership_created_by_app).toBe(1);
    expect(grant?.preexisting_role).toBeNull();
    expect(grant?.granted_at).toBe(timestamp);
    expect(grant?.effective_expires_at).toBe(expiresAt);
    expect(grant?.revoked_at).toBeNull();
  });

  it("should update grant status", () => {
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();

    grantRepo.createGrant({
      id: "grant-2",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const revokeTime = new Date().toISOString();
    grantRepo.updateGrantStatus("grant-2", "revoked", revokeTime);

    const updated = grantRepo.getGrant("grant-2");
    expect(updated?.status).toBe("revoked");
    expect(updated?.revoked_at).toBe(revokeTime);
  });
});
