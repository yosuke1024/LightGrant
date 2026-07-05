import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { ApprovalRepository } from "../../src/persistence/repositories/approval-repository.js";
import { RequestRepository } from "../../src/persistence/repositories/request-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import fs from "fs";
import path from "path";

describe("ApprovalRepository", () => {
  const tempDbPath = path.resolve("./tests/approval-repo-test.sqlite");
  let db: Database.Database;
  let approvalRepo: ApprovalRepository;
  let requestRepo: RequestRepository;
  let identityRepo: IdentityRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    process.env.DATABASE_PATH = tempDbPath;
    db = getDatabase();
    runMigrations(db);
    approvalRepo = new ApprovalRepository(db);
    requestRepo = new RequestRepository(db);
    identityRepo = new IdentityRepository(db);
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  beforeEach(() => {
    db.prepare("DELETE FROM approvals").run();
    db.prepare("DELETE FROM access_requests").run();
    db.prepare("DELETE FROM identity_links").run();
  });

  it("should create and retrieve approvals for a request", () => {
    const timestamp = new Date().toISOString();

    // Seed requester and approver identities
    identityRepo.createLink(
      "identity-req",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );
    identityRepo.createLink(
      "identity-appr",
      "W123",
      "U789",
      888,
      "approver-git",
      timestamp,
    );

    // Seed request
    requestRepo.createRequest({
      id: "req-1",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-req",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "Need access",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // Create approval
    approvalRepo.createApproval({
      id: "appr-1",
      accessRequestId: "req-1",
      decision: "approved",
      approverIdentityId: "identity-appr",
      approverGithubUserId: 888,
      authorityRole: "maintainer",
      authorityVerifiedAt: timestamp,
      reason: "Looks good to me",
      createdAt: timestamp,
    });

    const list = approvalRepo.getApprovalsForRequest("req-1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("appr-1");
    expect(list[0].access_request_id).toBe("req-1");
    expect(list[0].decision).toBe("approved");
    expect(list[0].approver_identity_id).toBe("identity-appr");
    expect(list[0].approver_github_user_id).toBe(888);
    expect(list[0].authority_role).toBe("maintainer");
    expect(list[0].authority_verified_at).toBe(timestamp);
    expect(list[0].reason).toBe("Looks good to me");
  });
});
