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
import { RevocationService } from "../../src/services/revocation-service.js";
import { JobWorker } from "../../src/workers/job-worker.js";
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { JobRepository } from "../../src/persistence/repositories/job-repository.js";
import { SlackNotifier } from "../../src/services/slack-notifier.js";
import { determineMembershipOrigin } from "../../src/domain/membership.js";
import { GitHubAccessProvider } from "../../src/integrations/github/github-client.js";

/**
 * Guards the product's most dangerous failure mode: removing a permanent team
 * member. A grant recorded with membership_created_by_app = 0 represents a
 * membership LightGrant did not create and therefore must never remove.
 *
 * These tests exist because the previous suite passed with the protection
 * deleted. Each one must fail if the corresponding guard is removed.
 */
describe("preexisting membership protection", () => {
  const tempDbPath = path.resolve("./tests/preexisting-protection-test.sqlite");
  let db: Database.Database;
  let grantRepo: GrantRepository;
  let identityRepo: IdentityRepository;
  let jobRepo: JobRepository;

  const mockGithubClient = {
    getOrganizationMembership: vi.fn(),
    getTeamMembership: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
  };

  const mockNotifier = {
    notifyRevocation: vi.fn().mockResolvedValue(undefined),
    postAuditRevocation: vi.fn().mockResolvedValue(undefined),
    notifyRequester: vi.fn().mockResolvedValue(undefined),
    postAuditLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackNotifier;

  const mockOrgContext = {
    organizationId: 1111,
    organizationLogin: "test-org",
    installationId: 5555,
  };

  /** Drive the real grant_access job end to end. */
  const runGrantJob = async (grantId: string, jobId: string) => {
    jobRepo.createJob({
      id: jobId,
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId }),
      runAfter: new Date().toISOString(),
    });
    const worker = new JobWorker(
      db,
      mockGithubClient as unknown as GitHubAccessProvider,
      mockNotifier,
      mockOrgContext,
    );
    await (worker as unknown as { runCycle: () => Promise<void> }).runCycle();
    await (worker as unknown as { runCycle: () => Promise<void> }).runCycle();
  };

  const seedPreexistingGrant = (id: string, timestamp: string) => {
    grantRepo.createGrant({
      id,
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      // A user who was already a member of the team before LightGrant ran.
      status: "already_present",
      membershipCreatedByApp: 0,
      preexistingRole: "member",
      grantedAt: timestamp,
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  };

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    grantRepo = new GrantRepository(db);
    identityRepo = new IdentityRepository(db);
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
    vi.clearAllMocks();
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM grants").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("DELETE FROM grant_requests").run();
    db.prepare("DELETE FROM jobs").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  describe("membership_created_by_app is monotonic", () => {
    it("does not flip the flag from 0 to 1", () => {
      const timestamp = new Date().toISOString();
      seedPreexistingGrant("grant-monotonic", timestamp);

      // The reactivation path asks to mark the grant as app-created.
      grantRepo.updateGrantStatusAndMembership(
        "grant-monotonic",
        "active",
        1,
        null,
      );

      const grant = grantRepo.getGrant("grant-monotonic");
      expect(grant?.membership_created_by_app).toBe(0);
    });

    it("does not wipe preexisting_role on a preexisting grant", () => {
      const timestamp = new Date().toISOString();
      seedPreexistingGrant("grant-role", timestamp);

      grantRepo.updateGrantStatusAndMembership("grant-role", "active", 1, null);

      const grant = grantRepo.getGrant("grant-role");
      expect(grant?.preexisting_role).toBe("member");
    });

    it("still lets an app-created grant record its membership normally", () => {
      const timestamp = new Date().toISOString();
      grantRepo.createGrant({
        id: "grant-app-created",
        githubOrgId: 1111,
        targetTeamId: 2222,
        githubUserId: 1000,
        githubLoginSnapshot: "hubot",
        status: "pending",
        membershipCreatedByApp: 1,
        preexistingRole: null,
        grantedAt: timestamp,
        effectiveExpiresAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      grantRepo.updateGrantStatusAndMembership(
        "grant-app-created",
        "active",
        1,
        null,
      );

      const grant = grantRepo.getGrant("grant-app-created");
      expect(grant?.membership_created_by_app).toBe(1);
      expect(grant?.status).toBe("active");
    });

    it("lets a grant be downgraded to preexisting when GitHub says so", () => {
      const timestamp = new Date().toISOString();
      grantRepo.createGrant({
        id: "grant-downgrade",
        githubOrgId: 1111,
        targetTeamId: 2222,
        githubUserId: 1001,
        githubLoginSnapshot: "dependabot",
        status: "pending",
        membershipCreatedByApp: 1,
        preexistingRole: null,
        grantedAt: timestamp,
        effectiveExpiresAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      grantRepo.updateGrantStatusAndMembership(
        "grant-downgrade",
        "already_present",
        0,
        "maintainer",
      );

      const grant = grantRepo.getGrant("grant-downgrade");
      expect(grant?.membership_created_by_app).toBe(0);
      expect(grant?.preexisting_role).toBe("maintainer");
    });
  });

  describe("confirmMembershipCreatedByAppAfterVerifiedAdd", () => {
    it("promotes the flag when the grant is mid-add", () => {
      const timestamp = new Date().toISOString();
      seedPreexistingGrant("grant-cas-ok", timestamp);
      grantRepo.updateMutationState("grant-cas-ok", {
        membershipMutationState: "add_request_sent",
      });

      const claimed = grantRepo.confirmMembershipCreatedByAppAfterVerifiedAdd(
        "grant-cas-ok",
        timestamp,
      );

      expect(claimed).toBe(true);
      const grant = grantRepo.getGrant("grant-cas-ok");
      expect(grant?.membership_created_by_app).toBe(1);
      expect(grant?.preexisting_role).toBeNull();
      expect(grant?.status).toBe("active");
      expect(grant?.membership_mutation_state).toBe("membership_confirmed");
    });

    // The CAS is what confines promotion to an add this app actually issued.
    // Without it the method would promote any grant handed to it.
    it.each([
      "not_started",
      "add_intent_recorded",
      "membership_confirmed",
      "reactivation_required",
    ])("refuses to promote a grant in %s", (mutationState) => {
      const timestamp = new Date().toISOString();
      const grantId = `grant-cas-${mutationState}`;
      seedPreexistingGrant(grantId, timestamp);
      grantRepo.updateMutationState(grantId, {
        membershipMutationState: mutationState,
      });

      const claimed = grantRepo.confirmMembershipCreatedByAppAfterVerifiedAdd(
        grantId,
        timestamp,
      );

      expect(claimed).toBe(false);
      const grant = grantRepo.getGrant(grantId);
      expect(grant?.membership_created_by_app).toBe(0);
      expect(grant?.preexisting_role).toBe("member");
    });
  });

  describe("determineMembershipOrigin", () => {
    it("reports preexisting during reactivation, not just at not_started", () => {
      const origin = determineMembershipOrigin({
        mutationState: "reactivation_required",
        membershipCreatedByApp: false,
        observedRole: "member",
      });

      expect(origin).toBe("preexisting");
    });

    it("reports app_created when the app created the membership", () => {
      const origin = determineMembershipOrigin({
        mutationState: "reactivation_required",
        membershipCreatedByApp: true,
        observedRole: "member",
      });

      expect(origin).toBe("app_created");
    });
  });

  describe("revocation", () => {
    it("never removes a preexisting member from the team", async () => {
      const timestamp = new Date().toISOString();
      identityRepo.createLink(
        "identity-p",
        "W123",
        "U456",
        999,
        "octocat",
        timestamp,
      );
      seedPreexistingGrant("grant-revoke", timestamp);

      mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });

      const service = new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );
      const grant = grantRepo.getGrant("grant-revoke");
      await service.revoke(grant!);

      expect(mockGithubClient.removeTeamMember).not.toHaveBeenCalled();
      expect(grantRepo.getGrant("grant-revoke")?.status).toBe("revoked");
    });

    it("never removes a preexisting member that was reactivated first", async () => {
      const timestamp = new Date().toISOString();
      identityRepo.createLink(
        "identity-r",
        "W123",
        "U789",
        999,
        "octocat",
        timestamp,
      );
      seedPreexistingGrant("grant-reactivated", timestamp);

      // Reproduce the reactivation round-trip: the grant is revived by a new
      // request, then the grant_access job confirms live membership and writes
      // the membership state back.
      grantRepo.reactivateGrant(
        "grant-reactivated",
        timestamp,
        "reactivation_required",
      );
      grantRepo.updateGrantStatusAndMembership(
        "grant-reactivated",
        "active",
        1,
        null,
      );

      mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });

      const service = new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );
      const grant = grantRepo.getGrant("grant-reactivated");
      await service.revoke(grant!);

      expect(mockGithubClient.removeTeamMember).not.toHaveBeenCalled();
    });

    it("removes a membership the app created after a verified add", async () => {
      const timestamp = new Date().toISOString();
      identityRepo.createLink(
        "identity-v",
        "W123",
        "U456",
        999,
        "octocat",
        timestamp,
      );
      seedPreexistingGrant("grant-verified-add", timestamp);

      // The user left the team while the grant was parked, so reactivation
      // finds nothing and LightGrant creates a brand new membership.
      grantRepo.reactivateGrant(
        "grant-verified-add",
        new Date(Date.now() + 60000).toISOString(),
        "reactivation_required",
      );

      mockGithubClient.getOrganizationMembership.mockResolvedValue({
        state: "active",
      });
      mockGithubClient.getTeamMembership
        .mockResolvedValueOnce(null) // reactivation live check: absent
        .mockResolvedValueOnce({ role: "member" }); // post-add verification
      mockGithubClient.addTeamMember.mockResolvedValue(undefined);

      await runGrantJob("grant-verified-add", "job-verified-add");

      expect(mockGithubClient.addTeamMember).toHaveBeenCalledWith(2222, 999);

      // LightGrant owns this membership now, so the flag must be promoted.
      const granted = grantRepo.getGrant("grant-verified-add");
      expect(granted?.status).toBe("active");
      expect(granted?.membership_created_by_app).toBe(1);
      expect(granted?.preexisting_role).toBeNull();

      // And the membership it created must be removed at expiry.
      const service = new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );
      mockGithubClient.getTeamMembership.mockReset();
      mockGithubClient.getTeamMembership
        .mockResolvedValueOnce({ role: "member" }) // pre-removal role check
        .mockResolvedValueOnce(null); // removal verification
      await service.revoke(grantRepo.getGrant("grant-verified-add")!);

      expect(mockGithubClient.removeTeamMember).toHaveBeenCalledTimes(1);
      expect(mockGithubClient.removeTeamMember).toHaveBeenCalledWith(2222, 999);
    });

    it("keeps the flag at 0 when an add times out and membership is merely observed", async () => {
      const timestamp = new Date().toISOString();
      identityRepo.createLink(
        "identity-u",
        "W123",
        "U456",
        999,
        "octocat",
        timestamp,
      );
      seedPreexistingGrant("grant-uncertain", timestamp);

      grantRepo.reactivateGrant(
        "grant-uncertain",
        new Date(Date.now() + 60000).toISOString(),
        "reactivation_required",
      );

      mockGithubClient.getOrganizationMembership.mockResolvedValue({
        state: "active",
      });
      mockGithubClient.getTeamMembership
        .mockResolvedValueOnce(null) // reactivation live check: absent
        .mockResolvedValueOnce({ role: "member" }); // post-timeout observation
      // The add call fails, so we cannot attribute the membership to LightGrant:
      // it may be the user's original permanent membership resurfacing.
      mockGithubClient.addTeamMember.mockRejectedValue(new Error("ETIMEDOUT"));

      await runGrantJob("grant-uncertain", "job-uncertain");

      const grant = grantRepo.getGrant("grant-uncertain");
      expect(grant?.membership_created_by_app).toBe(0);

      const service = new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );
      mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });
      await service.revoke(grantRepo.getGrant("grant-uncertain")!);

      expect(mockGithubClient.removeTeamMember).not.toHaveBeenCalled();
    });

    it("grants and revokes an ordinary new request as before", async () => {
      const timestamp = new Date().toISOString();
      identityRepo.createLink(
        "identity-n",
        "W123",
        "U777",
        1234,
        "newbie",
        timestamp,
      );
      grantRepo.createGrant({
        id: "grant-ordinary",
        githubOrgId: 1111,
        targetTeamId: 2222,
        githubUserId: 1234,
        githubLoginSnapshot: "newbie",
        status: "pending",
        membershipCreatedByApp: 1,
        preexistingRole: null,
        grantedAt: null,
        effectiveExpiresAt: new Date(Date.now() + 60000).toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      mockGithubClient.getOrganizationMembership.mockResolvedValue({
        state: "active",
      });
      mockGithubClient.getTeamMembership
        .mockResolvedValueOnce(null) // initial preexisting check: absent
        .mockResolvedValueOnce({ role: "member" }); // post-add verification
      mockGithubClient.addTeamMember.mockResolvedValue(undefined);

      await runGrantJob("grant-ordinary", "job-ordinary");

      const granted = grantRepo.getGrant("grant-ordinary");
      expect(granted?.status).toBe("active");
      expect(granted?.membership_created_by_app).toBe(1);

      const service = new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );
      mockGithubClient.getTeamMembership.mockReset();
      mockGithubClient.getTeamMembership
        .mockResolvedValueOnce({ role: "member" }) // pre-removal role check
        .mockResolvedValueOnce(null); // removal verification
      await service.revoke(grantRepo.getGrant("grant-ordinary")!);

      expect(mockGithubClient.removeTeamMember).toHaveBeenCalledWith(2222, 1234);
      expect(grantRepo.getGrant("grant-ordinary")?.status).toBe("revoked");
    });

    it("still removes a membership the app created", async () => {
      const timestamp = new Date().toISOString();
      identityRepo.createLink(
        "identity-a",
        "W123",
        "U999",
        1000,
        "hubot",
        timestamp,
      );
      grantRepo.createGrant({
        id: "grant-app",
        githubOrgId: 1111,
        targetTeamId: 2222,
        githubUserId: 1000,
        githubLoginSnapshot: "hubot",
        status: "active",
        membershipCreatedByApp: 1,
        preexistingRole: null,
        grantedAt: timestamp,
        effectiveExpiresAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });

      const service = new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );
      const grant = grantRepo.getGrant("grant-app");
      await service.revoke(grant!);

      expect(mockGithubClient.removeTeamMember).toHaveBeenCalledWith(2222, 1000);
    });
  });
});
