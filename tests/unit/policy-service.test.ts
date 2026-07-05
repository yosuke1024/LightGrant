import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { runMigrations } from "../../src/persistence/migrations.js";
import {
  PolicyService,
  generateSnapshotHash,
} from "../../src/services/policy-service.js";
import { canonicalJson } from "../../src/security/hashing.js";
import { PolicyRepository } from "../../src/persistence/repositories/policy-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";

describe("PolicyService", () => {
  const tempDbPath = path.resolve("./tests/policy-service-test.sqlite");
  let db: Database.Database;
  let policyRepo: PolicyRepository;
  let identityRepo: IdentityRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    policyRepo = new PolicyRepository(db);
    identityRepo = new IdentityRepository(db);
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

  it("should canonicalize JSON by sorting keys deterministically", () => {
    const objA = { b: 2, a: 1, c: { e: 5, d: 4 } };
    const objB = { a: 1, b: 2, c: { d: 4, e: 5 } };

    expect(canonicalJson(objA)).toBe(canonicalJson(objB));
    expect(generateSnapshotHash(objA as any)).toBe(
      generateSnapshotHash(objB as any),
    );
  });

  it("should create a new policy and version 1 on upsert", () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    const service = new PolicyService(db);
    const result = service.upsertPolicy({
      targetTeamId: 100,
      maxDurationMinutes: 120,
      requesterTeamIds: [200, 300],
      reasonRequired: true,
      slackWorkspaceId: "W123",
      githubOrgId: 1,
      createdByIdentityId: "identity-1",
    });

    expect(result.version).toBe(1);
    expect(result.policyId).toBeDefined();
    expect(result.snapshotHash).toHaveLength(64);

    const activePolicy = policyRepo.getPolicyForTeam(100);
    expect(activePolicy).not.toBeNull();
    expect(activePolicy!.version).toBe(1);
    expect(activePolicy!.max_duration_minutes).toBe(120);
    expect(activePolicy!.snapshot_hash).toBe(result.snapshotHash);
  });

  it("should append a new immutable version and increment version number on subsequent upserts", () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    const service = new PolicyService(db);

    // Initial version
    const res1 = service.upsertPolicy({
      targetTeamId: 100,
      maxDurationMinutes: 120,
      requesterTeamIds: [200, 300],
      reasonRequired: true,
      slackWorkspaceId: "W123",
      githubOrgId: 1,
      createdByIdentityId: "identity-1",
    });

    // Subsequent version (updates policy, appends version)
    const res2 = service.upsertPolicy({
      targetTeamId: 100,
      maxDurationMinutes: 180, // changed
      requesterTeamIds: [200, 300, 400], // changed
      reasonRequired: false, // changed
      slackWorkspaceId: "W123",
      githubOrgId: 1,
      createdByIdentityId: "identity-1",
    });

    expect(res2.policyId).toBe(res1.policyId);
    expect(res2.version).toBe(2);
    expect(res2.snapshotHash).not.toBe(res1.snapshotHash);

    const activePolicy = policyRepo.getPolicyForTeam(100)!;
    expect(activePolicy.version).toBe(2);
    expect(activePolicy.max_duration_minutes).toBe(180);

    // Ensure version 1 record is still preserved in DB
    const allVersions = db
      .prepare(
        "SELECT * FROM policy_versions WHERE policy_id = ? ORDER BY version ASC",
      )
      .all(res1.policyId);
    expect(allVersions).toHaveLength(2);
    expect((allVersions[0] as any).max_duration_minutes).toBe(120);
    expect((allVersions[1] as any).max_duration_minutes).toBe(180);
  });
});
