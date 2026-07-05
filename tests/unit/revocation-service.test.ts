import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { runMigrations } from "../../src/persistence/migrations.js";
import {
  RevocationService,
  calculateRevokeRetryDelay,
} from "../../src/services/revocation-service.js";
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { SlackNotifier } from "../../src/services/slack-notifier.js";

describe("RevocationService", () => {
  const tempDbPath = path.resolve("./tests/revocation-service-test.sqlite");
  let db: Database.Database;
  let grantRepo: GrantRepository;
  let identityRepo: IdentityRepository;

  const mockGithubClient = {
    getTeamMembership: vi.fn(),
    removeTeamMember: vi.fn(),
  };

  const mockNotifier = {
    notifyRevocation: vi.fn().mockResolvedValue(undefined),
    postAuditRevocation: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackNotifier;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    grantRepo = new GrantRepository(db);
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
    vi.clearAllMocks();
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM grants").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("DELETE FROM grant_requests").run();
    db.prepare("DELETE FROM jobs").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should calculate correct retry delay based on attempt count", () => {
    expect(calculateRevokeRetryDelay(1)).toBe(60);
    expect(calculateRevokeRetryDelay(2)).toBe(300);
    expect(calculateRevokeRetryDelay(3)).toBe(900);
    expect(calculateRevokeRetryDelay(4)).toBe(3600);
    expect(calculateRevokeRetryDelay(10)).toBe(3600);
  });

  it("should successfully revoke team membership and transition status to revoked", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

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
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // 1. Initial live check: is member
    mockGithubClient.getTeamMembership.mockResolvedValueOnce({
      role: "member",
    });
    // 2. Remove success
    mockGithubClient.removeTeamMember.mockResolvedValue(undefined);
    // 3. Verification live check: absent
    const notFoundError = new Error("Not Found");
    notFoundError.name = "GitHubNotFoundError";
    mockGithubClient.getTeamMembership.mockRejectedValueOnce(notFoundError);

    const service = new RevocationService(db, mockGithubClient, mockNotifier);
    const grant = grantRepo.getGrant("grant-1")!;
    await service.revoke(grant);

    const updated = grantRepo.getGrant("grant-1")!;
    expect(updated.status).toBe("revoked");
    expect(updated.revoked_at).not.toBeNull();
    expect(mockGithubClient.removeTeamMember).toHaveBeenCalledWith(2222, 999);

    const jobs = db
      .prepare("SELECT * FROM jobs WHERE type = 'notify_request_result'")
      .all();
    expect(jobs.length).toBe(1);
    const payload = JSON.parse(jobs[0].payload_json);
    expect(payload.status).toBe("revoked");

    const auditJobs = db
      .prepare("SELECT * FROM jobs WHERE type = 'post_audit_notification'")
      .all();
    expect(auditJobs.length).toBe(1);
  });

  it("should skip remove call and mark revoked when membership is already absent on GitHub", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

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
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const notFoundError = new Error("Not Found");
    notFoundError.name = "GitHubNotFoundError";
    mockGithubClient.getTeamMembership.mockRejectedValue(notFoundError);

    const service = new RevocationService(db, mockGithubClient, mockNotifier);
    const grant = grantRepo.getGrant("grant-2")!;
    await service.revoke(grant);

    const updated = grantRepo.getGrant("grant-2")!;
    expect(updated.status).toBe("revoked");
    expect(updated.revoked_at).not.toBeNull();
    expect(mockGithubClient.removeTeamMember).not.toHaveBeenCalled();
  });

  it("should protect elevated maintainer roles and set status to revoke_failed", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    grantRepo.createGrant({
      id: "grant-3",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    // Elevated to maintainer
    mockGithubClient.getTeamMembership.mockResolvedValue({
      role: "maintainer",
    });

    const service = new RevocationService(db, mockGithubClient, mockNotifier);
    const grant = grantRepo.getGrant("grant-3")!;
    await service.revoke(grant);

    const updated = grantRepo.getGrant("grant-3")!;
    expect(updated.status).toBe("revoke_failed");
    expect(updated.last_error_code).toBe("membership_elevated");
    expect(updated.next_revoke_attempt_at).not.toBeNull();
    const diff =
      new Date(updated.next_revoke_attempt_at!).getTime() - Date.now();
    expect(diff).toBeGreaterThan(3500 * 1000);
    expect(diff).toBeLessThan(3700 * 1000);
    expect(mockGithubClient.removeTeamMember).not.toHaveBeenCalled();

    const auditJobs = db
      .prepare("SELECT * FROM jobs WHERE type = 'post_audit_notification'")
      .all();
    expect(auditJobs.length).toBe(1);
  });

  it("should suppress alerts and only notify on attempt 1, 3, or after 24h", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    grantRepo.createGrant({
      id: "grant-4",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    mockGithubClient.getTeamMembership.mockRejectedValue(
      new Error("Transient API Error"),
    );

    const service = new RevocationService(db, mockGithubClient, mockNotifier);

    // Attempt 1: Should Alert
    let grant = grantRepo.getGrant("grant-4")!;
    await service.revoke(grant);
    let auditJobs = db
      .prepare("SELECT * FROM jobs WHERE type = 'post_audit_notification'")
      .all();
    expect(auditJobs.length).toBe(1);

    // Attempt 2: Should Suppress Alert
    grant = grantRepo.getGrant("grant-4")!;
    // Reset state to active to simulate re-trigger
    db.prepare(
      "UPDATE grants SET status = 'active' WHERE id = 'grant-4'",
    ).run();
    await service.revoke(grant);
    auditJobs = db
      .prepare("SELECT * FROM jobs WHERE type = 'post_audit_notification'")
      .all();
    expect(auditJobs.length).toBe(1); // Still 1

    // Attempt 3: Should Alert
    grant = grantRepo.getGrant("grant-4")!;
    db.prepare(
      "UPDATE grants SET status = 'active' WHERE id = 'grant-4'",
    ).run();
    await service.revoke(grant);
    auditJobs = db
      .prepare("SELECT * FROM jobs WHERE type = 'post_audit_notification'")
      .all();
    expect(auditJobs.length).toBe(2); // Alerted again
  });

  it("should cancel revocation if a new active request is approved concurrently", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    grantRepo.createGrant({
      id: "grant-cancel-test",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const requestRepo = new (
      await import("../../src/persistence/repositories/request-repository.js")
    ).RequestRepository(db);

    mockGithubClient.getTeamMembership.mockImplementationOnce(
      async (teamId, userId) => {
        // Concurrently approve request during revocation flow (after state changes to revoking)
        requestRepo.createRequest({
          id: "req-active-1",
          slackWorkspaceId: "W123",
          githubOrgId: 1111,
          requesterIdentityId: "identity-1",
          targetTeamId: 2222,
          durationMinutes: 60,
          reason: "Need extension",
          decisionStatus: "approved",
          decisionMode: "manual",
          matchedPolicyId: null,
          matchedPolicyVersion: null,
          requestedAt: timestamp,
          createdAt: timestamp,
          updatedAt: timestamp,
        });

        grantRepo.createGrantRequest(
          "grant-cancel-test",
          "req-active-1",
          new Date(Date.now() + 3600000).toISOString(),
        );

        return { role: "member" };
      },
    );

    const service = new RevocationService(db, mockGithubClient, mockNotifier);
    const grant = grantRepo.getGrant("grant-cancel-test")!;

    await service.revoke(grant);

    const updated = grantRepo.getGrant("grant-cancel-test")!;
    expect(updated.status).toBe("pending");
    expect(updated.membership_mutation_state).toBe("reactivation_required");
    expect(updated.revoked_at).toBeNull();
    expect(mockGithubClient.removeTeamMember).not.toHaveBeenCalled();

    const events = db
      .prepare("SELECT * FROM audit_events WHERE event_type = ?")
      .all("revoke.cancelled_due_to_new_request");
    expect(events.length).toBe(1);
  });

  it("should check maintainer role again after 1 hour, and remove if demoted to member", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-demote",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    grantRepo.createGrant({
      id: "grant-demote",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "revoke_failed",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextRevokeAttemptAt: new Date(Date.now() - 60000).toISOString(),
      lastErrorCode: "membership_elevated",
    });

    mockGithubClient.getTeamMembership.mockResolvedValueOnce({
      role: "member",
    });
    mockGithubClient.removeTeamMember.mockResolvedValue(undefined);
    const notFoundError = new Error("Not Found");
    notFoundError.name = "GitHubNotFoundError";
    mockGithubClient.getTeamMembership.mockRejectedValueOnce(notFoundError);

    const service = new RevocationService(db, mockGithubClient, mockNotifier);
    const grant = grantRepo.getGrant("grant-demote")!;
    await service.revoke(grant);

    const updated = grantRepo.getGrant("grant-demote")!;
    expect(updated.status).toBe("revoked");
    expect(updated.revoked_at).not.toBeNull();
    expect(mockGithubClient.removeTeamMember).toHaveBeenCalledWith(2222, 999);
  });

  it("should suppress elevated maintainer alerts, notifying only once per 24 hours unless error code changes", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-alert-suppress",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    grantRepo.createGrant({
      id: "grant-alert-suppress",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    mockGithubClient.getTeamMembership.mockResolvedValue({
      role: "maintainer",
    });

    const service = new RevocationService(db, mockGithubClient, mockNotifier);

    // First elevation check: Should Alert
    let grant = grantRepo.getGrant("grant-alert-suppress")!;
    await service.revoke(grant);
    let auditJobs = db
      .prepare("SELECT * FROM jobs WHERE type = 'post_audit_notification'")
      .all();
    expect(auditJobs.length).toBe(1);

    // Second elevation check (immediately): Should NOT Alert (suppressed)
    grant = grantRepo.getGrant("grant-alert-suppress")!;
    db.prepare(
      "UPDATE grants SET status = 'active' WHERE id = 'grant-alert-suppress'",
    ).run();
    await service.revoke(grant);
    auditJobs = db
      .prepare("SELECT * FROM jobs WHERE type = 'post_audit_notification'")
      .all();
    expect(auditJobs.length).toBe(1); // remain 1

    // Third check after 25 hours: Should Alert
    const pastTime = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    db.prepare(
      "UPDATE grants SET status = 'active', last_revoke_alert_at = ? WHERE id = 'grant-alert-suppress'",
    ).run(pastTime);
    grant = grantRepo.getGrant("grant-alert-suppress")!;
    await service.revoke(grant);
    auditJobs = db
      .prepare("SELECT * FROM jobs WHERE type = 'post_audit_notification'")
      .all();
    expect(auditJobs.length).toBe(2); // Alerted again
  });
});
