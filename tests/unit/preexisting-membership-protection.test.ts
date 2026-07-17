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
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
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

  const mockGithubClient = {
    getTeamMembership: vi.fn(),
    removeTeamMember: vi.fn(),
  };

  const mockNotifier = {
    notifyRevocation: vi.fn().mockResolvedValue(undefined),
    postAuditRevocation: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackNotifier;

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
