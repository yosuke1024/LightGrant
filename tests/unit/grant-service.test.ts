import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { runMigrations } from "../../src/persistence/migrations.js";
import { GrantService } from "../../src/services/grant-service.js";
import { RequestRepository } from "../../src/persistence/repositories/request-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { JobRepository } from "../../src/persistence/repositories/job-repository.js";

describe("GrantService", () => {
  const tempDbPath = path.resolve("./tests/grant-service-test.sqlite");
  let db: Database.Database;
  let grantService: GrantService;
  let requestRepo: RequestRepository;
  let identityRepo: IdentityRepository;
  let grantRepo: GrantRepository;
  let jobRepo: JobRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    grantService = new GrantService(db);
    requestRepo = new RequestRepository(db);
    identityRepo = new IdentityRepository(db);
    grantRepo = new GrantRepository(db);
    jobRepo = new JobRepository(db);
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
    db.prepare("DELETE FROM access_requests").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("DELETE FROM grants").run();
    db.prepare("DELETE FROM grant_requests").run();
    db.prepare("DELETE FROM jobs").run();
    db.prepare("DELETE FROM approvals").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should create new grant, link request, and enqueue job on approval", () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    requestRepo.createRequest({
      id: "req-1",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-1",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "Needs database access",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const result = grantService.createGrantIntentTx({
      requestId: "req-1",
      decisionMode: "manual",
      approverIdentityId: "identity-1",
      approverGithubUserId: 999,
      authorityRole: "team_maintainer",
    });

    expect(result.grantId).toBeDefined();

    // Verify request updated
    const req = requestRepo.getRequest("req-1");
    expect(req?.decision_status).toBe("approved");

    // Verify grant created
    const grant = grantRepo.getGrant(result.grantId);
    expect(grant).toBeDefined();
    expect(grant?.status).toBe("pending");
    expect(grant?.github_user_id).toBe(999);

    // Verify grant_requests mapping
    const mappings = grantRepo.listGrantRequests(result.grantId);
    expect(mappings.length).toBe(1);
    expect(mappings[0].access_request_id).toBe("req-1");

    // Verify job created
    const jobs = jobRepo.acquireNextJobs("test-worker", 5, 60);
    expect(jobs.length).toBe(1);
    expect(jobs[0].type).toBe("grant_access");
    expect(JSON.parse(jobs[0].payload_json).grantId).toBe(result.grantId);
  });

  it("should extend existing active grant if new request is approved", () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    // 1. Create first request (60 min)
    requestRepo.createRequest({
      id: "req-1",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-1",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "Access 1",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const res1 = grantService.createGrantIntentTx({
      requestId: "req-1",
      decisionMode: "manual",
      approverIdentityId: "identity-1",
      approverGithubUserId: 999,
      authorityRole: "team_maintainer",
    });

    // 2. Create second request (120 min)
    requestRepo.createRequest({
      id: "req-2",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-1",
      targetTeamId: 2222,
      durationMinutes: 120,
      reason: "Access 2",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const res2 = grantService.createGrantIntentTx({
      requestId: "req-2",
      decisionMode: "manual",
      approverIdentityId: "identity-1",
      approverGithubUserId: 999,
      authorityRole: "team_maintainer",
    });

    expect(res1.grantId).toBe(res2.grantId);

    const grant = grantRepo.getGrant(res1.grantId);
    expect(grant).toBeDefined();

    // Verify expiration calculation (should be extended)
    const expiresAt = new Date(grant!.effective_expires_at).getTime();
    const minExpectedExpires = Date.now() + 110 * 60 * 1000; // slightly less than 120m to account for delays
    expect(expiresAt).toBeGreaterThan(minExpectedExpires);

    // Verify both requests mapped to same grant
    const mappings = grantRepo.listGrantRequests(res1.grantId);
    expect(mappings.length).toBe(2);

    const events = db
      .prepare("SELECT * FROM audit_events WHERE event_type = ?")
      .all("grant.expiration_extended") as any[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload_json);
    expect(payload.new_expires_at).toBe(grant!.effective_expires_at);
  });

  it("should fail to double-approve same request (CAS violation)", () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    requestRepo.createRequest({
      id: "req-1",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-1",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "Access 1",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // First approval succeeds
    grantService.createGrantIntentTx({
      requestId: "req-1",
      decisionMode: "manual",
      approverIdentityId: "identity-1",
      approverGithubUserId: 999,
      authorityRole: "team_maintainer",
    });

    // Second approval fails
    expect(() => {
      grantService.createGrantIntentTx({
        requestId: "req-1",
        decisionMode: "manual",
        approverIdentityId: "identity-1",
        approverGithubUserId: 999,
        authorityRole: "team_maintainer",
      });
    }).toThrow("concurrent update");
  });
});
