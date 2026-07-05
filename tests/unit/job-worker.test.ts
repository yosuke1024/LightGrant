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
import { JobWorker } from "../../src/workers/job-worker.js";
import { JobRepository } from "../../src/persistence/repositories/job-repository.js";
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { SlackNotifier } from "../../src/services/slack-notifier.js";

describe("JobWorker", () => {
  const tempDbPath = path.resolve("./tests/job-worker-test.sqlite");
  let db: Database.Database;
  let jobRepo: JobRepository;
  let grantRepo: GrantRepository;
  let identityRepo: IdentityRepository;

  const mockGithubClient = {
    getOrganizationMembership: vi.fn(),
    getTeamMembership: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
  };

  const mockNotifier = {
    notifyRequester: vi.fn().mockResolvedValue(undefined),
    postAuditLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackNotifier;

  const mockOrgContext = {
    organizationId: 1111,
    organizationLogin: "test-org",
    installationId: 5555,
  };

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    jobRepo = new JobRepository(db);
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
    db.prepare("DELETE FROM jobs").run();
    db.prepare("DELETE FROM grants").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("DELETE FROM grant_requests").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should successfully fulfill pending grant and transition status to active", async () => {
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
      status: "pending",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: null,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    jobRepo.createJob({
      id: "job-1",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-1" }),
      runAfter: timestamp,
    });

    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "active",
    });
    // Initially not a member of team
    const notFoundError = new Error("Not Found");
    notFoundError.name = "GitHubNotFoundError";
    mockGithubClient.getTeamMembership.mockRejectedValueOnce(notFoundError);
    // Add success
    mockGithubClient.addTeamMember.mockResolvedValue(undefined);
    // Verification of addition
    mockGithubClient.getTeamMembership.mockResolvedValueOnce({
      role: "member",
    });

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    // Manually run a cycle
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    // Verify DB states
    const grant = grantRepo.getGrant("grant-1");
    expect(grant?.status).toBe("active");
    expect(grant?.membership_created_by_app).toBe(1);

    const lockedJobs = jobRepo.acquireNextJobs("test", 5, 60);
    // Since job is completed, it shouldn't be acquired
    expect(lockedJobs.length).toBe(0);

    // Verify Slack notify triggered
    expect(mockNotifier.notifyRequester).toHaveBeenCalledWith(
      expect.objectContaining({
        slackUserId: "U456",
        status: "approved",
      }),
    );
  });

  it("should handle already present team membership and skip creation", async () => {
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
      status: "pending",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: null,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    jobRepo.createJob({
      id: "job-2",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-2" }),
      runAfter: timestamp,
    });

    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "active",
    });
    // User already a member
    mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    const grant = grantRepo.getGrant("grant-2");
    expect(grant?.status).toBe("already_present");
    expect(grant?.membership_created_by_app).toBe(0);
    expect(grant?.preexisting_role).toBe("member");

    expect(mockGithubClient.addTeamMember).not.toHaveBeenCalled();
  });

  it("should fail permanently when requester is not an active org member", async () => {
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
      status: "pending",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: null,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    jobRepo.createJob({
      id: "job-3",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-3" }),
      runAfter: timestamp,
    });

    // Inactive state
    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "pending",
    });

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    const grant = grantRepo.getGrant("grant-3");
    expect(grant?.status).toBe("grant_failed");
    expect(grant?.last_error_code).toBe("organization_membership_inactive");
  });

  it("should recover from uncertain status (add_request_sent) when membership is found in retry", async () => {
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
      id: "grant-recover-1",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "pending",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: null,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
      membershipMutationState: "add_request_sent",
      membershipAddAttemptedAt: timestamp,
      membershipAddOperationId: "op-123",
      membershipAddLastVerifiedAt: null,
    });

    jobRepo.createJob({
      id: "job-recover-1",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-recover-1" }),
      runAfter: timestamp,
    });

    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "active",
    });
    mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    const grant = grantRepo.getGrant("grant-recover-1");
    expect(grant?.status).toBe("active");
    expect(grant?.membership_mutation_state).toBe("membership_confirmed");
    expect(grant?.membership_created_by_app).toBe(1);
    expect(mockGithubClient.addTeamMember).not.toHaveBeenCalled();

    const events = db
      .prepare("SELECT * FROM audit_events WHERE event_type = ?")
      .all("grant.recovered_after_uncertain_result");
    expect(events.length).toBe(1);
    expect(JSON.parse((events[0] as any).payload_json)).toMatchObject({
      operation_id: "op-123",
      previous_mutation_state: "add_request_sent",
      observed_role: "member",
    });
  });

  it("should handle API timeout on addTeamMember, and retry if membership is still not found", async () => {
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
      id: "grant-timeout-fail",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "pending",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: null,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
      membershipMutationState: "add_intent_recorded",
      membershipAddAttemptedAt: timestamp,
      membershipAddOperationId: "op-456",
      membershipAddLastVerifiedAt: null,
    });

    jobRepo.createJob({
      id: "job-timeout-fail",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-timeout-fail" }),
      runAfter: timestamp,
    });

    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "active",
    });
    const notFoundError = new Error("Not Found");
    notFoundError.name = "GitHubNotFoundError";
    mockGithubClient.getTeamMembership.mockRejectedValueOnce(notFoundError);
    mockGithubClient.addTeamMember.mockRejectedValueOnce(
      new Error("API Timeout"),
    );
    mockGithubClient.getTeamMembership.mockRejectedValueOnce(notFoundError);

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();

    const dbJob = db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get("job-timeout-fail") as any;
    expect(dbJob.status).toBe("queued");
    expect(dbJob.attempt_count).toBe(1);

    const grant = grantRepo.getGrant("grant-timeout-fail");
    expect(grant?.status).toBe("pending");
    expect(grant?.membership_mutation_state).toBe("add_request_sent");
  });

  it("should handle API timeout on addTeamMember, and complete successfully if membership is found active", async () => {
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
      id: "grant-timeout-success",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "pending",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: null,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
      membershipMutationState: "add_intent_recorded",
      membershipAddAttemptedAt: timestamp,
      membershipAddOperationId: "op-789",
      membershipAddLastVerifiedAt: null,
    });

    jobRepo.createJob({
      id: "job-timeout-success",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-timeout-success" }),
      runAfter: timestamp,
    });

    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "active",
    });
    const notFoundError = new Error("Not Found");
    notFoundError.name = "GitHubNotFoundError";
    mockGithubClient.getTeamMembership.mockRejectedValueOnce(notFoundError);
    mockGithubClient.addTeamMember.mockRejectedValueOnce(
      new Error("API Timeout"),
    );
    mockGithubClient.getTeamMembership.mockResolvedValueOnce({
      role: "member",
    });

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    const dbJob = db
      .prepare("SELECT * FROM jobs WHERE id = ?")
      .get("job-timeout-success") as any;
    expect(dbJob.status).toBe("completed");

    const grant = grantRepo.getGrant("grant-timeout-success");
    expect(grant?.status).toBe("active");
    expect(grant?.membership_mutation_state).toBe("membership_confirmed");

    const events = db
      .prepare(
        "SELECT * FROM audit_events WHERE event_type = ? AND grant_id = ?",
      )
      .all("grant.recovered_after_uncertain_result", "grant-timeout-success");
    expect(events.length).toBe(1);
  });

  it("should record grant.failed audit event when job reaches max attempts and fails permanently", async () => {
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
      id: "grant-fail-test",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "pending",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: null,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    jobRepo.createJob({
      id: "job-fail-test",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-fail-test" }),
      runAfter: timestamp,
    });

    db.prepare(
      "UPDATE jobs SET attempt_count = 10 WHERE id = 'job-fail-test'",
    ).run();

    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "active",
    });
    const notFoundError = new Error("Not Found");
    notFoundError.name = "GitHubNotFoundError";
    mockGithubClient.getTeamMembership.mockRejectedValue(notFoundError);
    mockGithubClient.addTeamMember.mockRejectedValue(
      new Error("Persistent API Failure"),
    );

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    const grant = grantRepo.getGrant("grant-fail-test");
    expect(grant?.status).toBe("grant_failed");

    const events = db
      .prepare(
        "SELECT * FROM audit_events WHERE event_type = ? AND grant_id = ?",
      )
      .all("grant.failed", "grant-fail-test");
    expect(events.length).toBe(1);
    const payload = JSON.parse((events[0] as any).payload_json);
    expect(payload.error_code).toBe("max_attempts_exceeded");
  });

  it("should record grant.membership_elevated audit event when maintainer role is detected during retry recheck", async () => {
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
      id: "grant-elevated-recovery-test",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "pending",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: null,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
      membershipMutationState: "add_request_sent",
      membershipAddAttemptedAt: timestamp,
      membershipAddOperationId: "op-elevated",
    });

    jobRepo.createJob({
      id: "job-elevated-recovery-test",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-elevated-recovery-test" }),
      runAfter: timestamp,
    });

    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "active",
    });
    mockGithubClient.getTeamMembership.mockResolvedValue({
      role: "maintainer",
    });

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    const grant = grantRepo.getGrant("grant-elevated-recovery-test");
    expect(grant?.status).toBe("active");
    expect(grant?.membership_created_by_app).toBe(1);
    expect(grant?.last_error_code).toBe("membership_elevated");

    const events = db
      .prepare(
        "SELECT * FROM audit_events WHERE event_type = ? AND grant_id = ?",
      )
      .all("grant.membership_elevated", "grant-elevated-recovery-test");
    expect(events.length).toBe(1);
  });

  it("should fail permanently and update team sync cache when GitHubIdpSyncError occurs during addTeamMember", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-idp-test",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    const teamRepo = new (
      await import("../../src/persistence/repositories/team-repository.js")
    ).TeamRepository(db);
    teamRepo.upsertTeams(
      1111,
      [
        {
          id: 2222,
          name: "IdP Sync Team",
          slug: "idp-sync-team",
          description: "",
          privacy: "closed",
        },
      ],
      timestamp,
    );

    grantRepo.createGrant({
      id: "grant-idp-test",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "pending",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: null,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    jobRepo.createJob({
      id: "job-idp-test",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-idp-test" }),
      runAfter: timestamp,
    });

    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "active",
    });
    const notFoundError = new Error("Not Found");
    notFoundError.name = "GitHubNotFoundError";
    mockGithubClient.getTeamMembership.mockRejectedValueOnce(notFoundError);

    const idpError = new Error(
      "Manually manage members of a team synchronized",
    );
    idpError.name = "GitHubIdpSyncError";
    mockGithubClient.addTeamMember.mockRejectedValueOnce(idpError);

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    const grant = grantRepo.getGrant("grant-idp-test")!;
    expect(grant.status).toBe("grant_failed");
    expect(grant.last_error_code).toBe("github_team_sync_managed");

    const cachedTeam = teamRepo.getTeam(2222)!;
    expect(cachedTeam.synchronized_flag).toBe(1);

    const dbJob = db
      .prepare("SELECT * FROM jobs WHERE id = 'job-idp-test'")
      .get() as any;
    expect(dbJob.status).toBe("failed");
    expect(dbJob.attempt_count).toBe(1);

    const syncEvents = db
      .prepare(
        "SELECT * FROM audit_events WHERE event_type = ? AND github_team_id = ?",
      )
      .all("team.unsupported_idp_sync", 2222);
    expect(syncEvents.length).toBe(1);

    const failEvents = db
      .prepare(
        "SELECT * FROM audit_events WHERE event_type = ? AND grant_id = ?",
      )
      .all("grant.failed", "grant-idp-test");
    expect(failEvents.length).toBe(1);
    const failPayload = JSON.parse((failEvents[0] as any).payload_json);
    expect(failPayload.error_code).toBe("github_team_sync_managed");
  });

  it("should isolate notification job failure and not change grant status on notify_request_result dead letter", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink("identity-notif", "W123", "U456", 999, "octocat", timestamp);
    grantRepo.createGrant({
      id: "grant-notif-fail",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active", // Keep it active
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    jobRepo.createJob({
      id: "job-notif-fail",
      type: "notify_request_result",
      payloadJson: JSON.stringify({
        requestId: "grant-notif-fail",
        slackUserId: "U456",
        teamName: "Test Team",
        status: "approved",
        durationMinutes: 60,
      }),
      runAfter: timestamp,
    });

    // Make it look like it reached max attempts
    db.prepare("UPDATE jobs SET attempt_count = 10 WHERE id = 'job-notif-fail'").run();

    // Trigger failure by making mockNotifier reject
    mockNotifier.notifyRequester = vi.fn().mockRejectedValue(new Error("Slack API Down"));

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    // The job should be failed
    const dbJob = db.prepare("SELECT * FROM jobs WHERE id = 'job-notif-fail'").get() as any;
    expect(dbJob.status).toBe("failed");

    // BUT the grant MUST still be active
    const grant = grantRepo.getGrant("grant-notif-fail");
    expect(grant?.status).toBe("active");
  });

  it("should schedule revoke_access job for retry in 1 hour indefinitely upon failure", async () => {
    const timestamp = new Date().toISOString();
    grantRepo.createGrant({
      id: "grant-revoke-retry-test",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: new Date(Date.now() - 60000).toISOString(), // Expired
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    jobRepo.createJob({
      id: "job-revoke-retry-test",
      type: "revoke_access",
      payloadJson: JSON.stringify({ grantId: "grant-revoke-retry-test" }),
      runAfter: timestamp,
    });

    // Force API Failure during revoke
    mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });
    mockGithubClient.removeTeamMember.mockRejectedValue(new Error("GitHub API rate limit"));

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    // Job should be queued again, NOT failed, even though it's run.
    const dbJob = db.prepare("SELECT * FROM jobs WHERE id = 'job-revoke-retry-test'").get() as any;
    expect(dbJob.status).toBe("queued");
    
    // nextAttemptAt should be roughly 1 hour from now
    const runAfterTime = new Date(dbJob.run_after).getTime();
    const nowTime = Date.now();
    expect(runAfterTime - nowTime).toBeGreaterThan(3500 * 1000);
    expect(runAfterTime - nowTime).toBeLessThan(3700 * 1000);

    // Grant status should be 'revoke_failed'
    const grant = grantRepo.getGrant("grant-revoke-retry-test")!;
    expect(grant.status).toBe("revoke_failed");
  });

  it("should recover stale webhook deliveries and enqueue reprocess job when attempt_count is within limit", async () => {
    const now = new Date();
    const expiredLease = new Date(now.getTime() - 10000).toISOString(); // 10s ago

    // Insert a stale webhook delivery
    db.prepare(
      `
      INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, lease_expires_at, attempt_count, payload_json)
      VALUES ('github', 'delivery-stale-1', 'membership', ?, 'processing', ?, 1, ?)
    `,
    ).run(
      now.toISOString(),
      expiredLease,
      JSON.stringify({
        action: "removed",
        team: { id: 2222 },
        member: { id: 999, login: "octocat" },
        organization: { id: 1111 },
      }),
    );

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    // Reset lastWebhookRecoveryAt to allow immediate run
    (worker as any).lastWebhookRecoveryAt = 0;

    (worker as any).recoverStaleWebhookDeliveries();

    // Verify delivery status updated to failed
    const delivery = db
      .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = 'delivery-stale-1'")
      .get() as any;
    expect(delivery.status).toBe("failed");
    expect(delivery.last_error).toBe("processing_lease_expired");
    expect(delivery.lease_expires_at).toBeNull();

    // Verify reprocess job is enqueued
    const job = db
      .prepare("SELECT * FROM jobs WHERE type = 'reprocess_webhook'")
      .get() as any;
    expect(job).toBeDefined();
    expect(JSON.parse(job.payload_json).deliveryId).toBe("delivery-stale-1");

    // Verify Audit events recorded
    const events = db
      .prepare("SELECT event_type FROM audit_events WHERE event_type LIKE 'webhook.%'")
      .all() as any[];
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain("webhook.processing_lease_expired");
    expect(eventTypes).toContain("webhook.redelivery_recovered");
  });

  it("should permanently fail stale webhook deliveries without enqueuing reprocess job when attempt_count exceeds limit", async () => {
    const now = new Date();
    const expiredLease = new Date(now.getTime() - 10000).toISOString();

    // Insert a stale webhook delivery with attempt_count = 11
    db.prepare(
      `
      INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, lease_expires_at, attempt_count, payload_json)
      VALUES ('github', 'delivery-stale-max', 'membership', ?, 'processing', ?, 11, ?)
    `,
    ).run(
      now.toISOString(),
      expiredLease,
      JSON.stringify({
        action: "removed",
        team: { id: 2222 },
        member: { id: 999, login: "octocat" },
        organization: { id: 1111 },
      }),
    );

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    (worker as any).lastWebhookRecoveryAt = 0;

    (worker as any).recoverStaleWebhookDeliveries();

    // Verify delivery status updated to failed
    const delivery = db
      .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = 'delivery-stale-max'")
      .get() as any;
    expect(delivery.status).toBe("failed");
    expect(delivery.last_error).toBe("processing_lease_expired");

    // Verify reprocess job is NOT enqueued
    const job = db
      .prepare("SELECT * FROM jobs WHERE type = 'reprocess_webhook' AND payload_json LIKE '%delivery-stale-max%'")
      .get() as any;
    expect(job).toBeUndefined();

    // Verify Audit events recorded
    const events = db
      .prepare("SELECT event_type FROM audit_events WHERE event_type LIKE 'webhook.%'")
      .all() as any[];
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain("webhook.processing_lease_expired");
    expect(eventTypes).toContain("webhook.permanently_failed");
  });

  it("should skip recovery for active webhook delivery leases", async () => {
    const now = new Date();
    const activeLease = new Date(now.getTime() + 10000).toISOString(); // 10s in future

    db.prepare(
      `
      INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, lease_expires_at, attempt_count, payload_json)
      VALUES ('github', 'delivery-active-1', 'membership', ?, 'processing', ?, 1, ?)
    `,
    ).run(
      now.toISOString(),
      activeLease,
      JSON.stringify({}),
    );

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    (worker as any).lastWebhookRecoveryAt = 0;

    (worker as any).recoverStaleWebhookDeliveries();

    // Verify delivery status remains processing
    const delivery = db
      .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = 'delivery-active-1'")
      .get() as any;
    expect(delivery.status).toBe("processing");
    expect(delivery.lease_expires_at).toBe(activeLease);

    // Verify no job is enqueued
    const job = db
      .prepare("SELECT * FROM jobs WHERE type = 'reprocess_webhook' AND payload_json LIKE '%delivery-active-1%'")
      .get() as any;
    expect(job).toBeUndefined();
  });

  it("should successfully execute reprocess_webhook job via job execution cycle", async () => {
    const now = new Date().toISOString();
    
    // Insert a failed/stale webhook delivery
    db.prepare(
      `
      INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, lease_expires_at, attempt_count, payload_json)
      VALUES ('github', 'delivery-reprocess-1', 'membership', ?, 'failed', NULL, 1, ?)
    `,
    ).run(
      now,
      JSON.stringify({
        action: "removed",
        team: { id: 2222 },
        member: { id: 999, login: "octocat" },
        organization: { id: 1111 },
      }),
    );

    // Enqueue reprocess job
    jobRepo.createJob({
      id: "job-reprocess-test",
      type: "reprocess_webhook",
      payloadJson: JSON.stringify({ deliveryId: "delivery-reprocess-1" }),
      runAfter: now,
    });

    // Mock github client responses for WebhookService
    mockGithubClient.getTeamMembership.mockResolvedValue(null); // User removed on GitHub
    
    // We also need an active grant to trigger the removal drift logic
    grantRepo.createGrant({
      id: "grant-drift-test",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: now,
      effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
      createdAt: now,
      updatedAt: now,
    });

    const worker = new JobWorker(db, mockGithubClient, mockNotifier, mockOrgContext);
    await (worker as any).runCycle();

    // Verify webhook delivery status updated to processed
    const delivery = db
      .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = 'delivery-reprocess-1'")
      .get() as any;
    expect(delivery.status).toBe("processed");
    expect(delivery.processed_at).toBeDefined();

    // Verify job is completed/removed from queue
    const lockedJobs = jobRepo.acquireNextJobs("test", 5, 60);
    expect(lockedJobs.length).toBe(0);
  });
});
