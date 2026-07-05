import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { RequestRepository } from "../../src/persistence/repositories/request-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import fs from "fs";
import path from "path";

describe("RequestRepository", () => {
  const tempDbPath = path.resolve("./tests/request-repo-test.sqlite");
  let db: Database.Database;
  let requestRepo: RequestRepository;
  let identityRepo: IdentityRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    requestRepo = new RequestRepository(db);
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
    db.prepare("DELETE FROM access_requests").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should create and retrieve an access request", () => {
    const timestamp = new Date().toISOString();

    // Seed an identity link because of foreign key constraint
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
      reason: "Need access to debug",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const req = requestRepo.getRequest("req-1");
    expect(req).not.toBeNull();
    expect(req?.id).toBe("req-1");
    expect(req?.slack_workspace_id).toBe("W123");
    expect(req?.github_org_id).toBe(1111);
    expect(req?.requester_identity_id).toBe("identity-1");
    expect(req?.target_team_id).toBe(2222);
    expect(req?.duration_minutes).toBe(60);
    expect(req?.reason).toBe("Need access to debug");
    expect(req?.decision_status).toBe("pending");
    expect(req?.decision_mode).toBeNull();
    expect(req?.slack_approval_channel_id).toBeNull();
    expect(req?.slack_approval_message_ts).toBeNull();
  });

  it("should update decision status using CAS", () => {
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
      id: "req-2",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-1",
      targetTeamId: 2222,
      durationMinutes: 120,
      reason: "Testing updates",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const decideTime = new Date().toISOString();
    const changes = requestRepo.updateDecisionStatus(
      "req-2",
      "approved",
      "manual",
      decideTime,
      null,
    );
    expect(changes).toBe(1);

    const updated = requestRepo.getRequest("req-2");
    expect(updated?.decision_status).toBe("approved");
    expect(updated?.decision_mode).toBe("manual");
    expect(updated?.decided_at).toBe(decideTime);
    expect(updated?.denied_reason).toBeNull();

    // Try denying already approved request -> should fail (0 changes) due to CAS
    const denyTime = new Date().toISOString();
    const failedChanges = requestRepo.updateDecisionStatus(
      "req-2",
      "denied",
      "manual",
      denyTime,
      "Too long duration",
    );
    expect(failedChanges).toBe(0);
    const notDenied = requestRepo.getRequest("req-2");
    expect(notDenied?.decision_status).toBe("approved"); // Still approved

    // Test denying a fresh pending request
    requestRepo.createRequest({
      id: "req-2-deny",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-1",
      targetTeamId: 2222,
      durationMinutes: 120,
      reason: "Testing updates",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const denyChanges = requestRepo.updateDecisionStatus(
      "req-2-deny",
      "denied",
      "manual",
      denyTime,
      "Too long duration",
    );
    expect(denyChanges).toBe(1);
    const denied = requestRepo.getRequest("req-2-deny");
    expect(denied?.decision_status).toBe("denied");
    expect(denied?.denied_reason).toBe("Too long duration");
  });

  it("should update Slack message info", () => {
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
      id: "req-3",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-1",
      targetTeamId: 2222,
      durationMinutes: 120,
      reason: "Testing slack updates",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    requestRepo.updateSlackMessageInfo("req-3", "C999", "12345678.90");

    const updated = requestRepo.getRequest("req-3");
    expect(updated?.slack_approval_channel_id).toBe("C999");
    expect(updated?.slack_approval_message_ts).toBe("12345678.90");
  });
});
