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
  REVOKE_LEASE_SECONDS,
} from "../../src/services/revocation-service.js";
import { ReconciliationService } from "../../src/services/reconciliation-service.js";
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { SlackNotifier } from "../../src/services/slack-notifier.js";
import { GitHubAccessProvider } from "../../src/integrations/github/github-client.js";

/**
 * A grant that entered 'revoking' and never came back — the process died
 * mid-revocation — used to sit there forever: nothing selected it and nothing
 * reset it, so temporary access silently became permanent. Revocation now
 * leases the grant, and an expired lease is reclaimable.
 */
describe("stranded revoking grants", () => {
  const tempDbPath = path.resolve("./tests/stranded-revoking-test.sqlite");
  let db: Database.Database;
  let grantRepo: GrantRepository;
  let identityRepo: IdentityRepository;

  const mockGithubClient = {
    getOrganizationMembership: vi.fn(),
    getTeamMembership: vi.fn(),
    addTeamMember: vi.fn(),
    removeTeamMember: vi.fn(),
    listTeams: vi.fn().mockResolvedValue([]),
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

  const expiredAt = () => new Date(Date.now() - 60_000).toISOString();

  /** Seed an expired grant already parked in 'revoking'. */
  const seedStrandedGrant = (grantId: string, leaseStartedAt: string | null) => {
    const timestamp = new Date().toISOString();
    grantRepo.createGrant({
      id: grantId,
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: expiredAt(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    db.prepare(
      `UPDATE grants SET status = 'revoking', revoking_started_at = ? WHERE id = ?`,
    ).run(leaseStartedAt, grantId);
  };

  const staleLeaseStart = () =>
    new Date(Date.now() - (REVOKE_LEASE_SECONDS + 60) * 1000).toISOString();
  const freshLeaseStart = () => new Date().toISOString();

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
    // resetAllMocks, not clearAllMocks: clear keeps implementations, so a
    // rejection queued by one test would leak into the next.
    vi.resetAllMocks();
    mockGithubClient.listTeams.mockResolvedValue([]);
    mockGithubClient.removeTeamMember.mockResolvedValue(undefined);
    mockGithubClient.addTeamMember.mockResolvedValue(undefined);
    mockGithubClient.getOrganizationMembership.mockResolvedValue({
      state: "active",
    });
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM grants").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("DELETE FROM grant_requests").run();
    db.prepare("DELETE FROM jobs").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      new Date().toISOString(),
    );
  });

  const staleBefore = (now: string) =>
    new Date(Date.parse(now) - REVOKE_LEASE_SECONDS * 1000).toISOString();

  describe("getExpiredGrants", () => {
    it("reclaims a revoking grant whose lease has expired", () => {
      seedStrandedGrant("grant-stale", staleLeaseStart());
      const now = new Date().toISOString();

      const expired = grantRepo.getExpiredGrants(now, staleBefore(now));

      expect(expired.map((g) => g.id)).toContain("grant-stale");
    });

    it("leaves a revocation that is still in flight alone", () => {
      seedStrandedGrant("grant-fresh", freshLeaseStart());
      const now = new Date().toISOString();

      const expired = grantRepo.getExpiredGrants(now, staleBefore(now));

      expect(expired.map((g) => g.id)).not.toContain("grant-fresh");
    });

    it("reclaims a revoking grant that carries no lease at all", () => {
      // Rows stranded before leases existed, backfilled by the migration to a
      // known instant; anything still lacking one holds no live claim.
      seedStrandedGrant("grant-no-lease", null);
      const now = new Date().toISOString();

      const expired = grantRepo.getExpiredGrants(now, staleBefore(now));

      expect(expired.map((g) => g.id)).toContain("grant-no-lease");
    });
  });

  describe("revoke", () => {
    const buildService = () =>
      new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );

    it("revokes a grant whose revoke lease went stale", async () => {
      seedStrandedGrant("grant-recover", staleLeaseStart());
      mockGithubClient.getTeamMembership
        .mockResolvedValueOnce({ role: "member" }) // pre-removal role check
        .mockResolvedValueOnce(null); // removal verification

      await buildService().revoke(grantRepo.getGrant("grant-recover")!);

      expect(mockGithubClient.removeTeamMember).toHaveBeenCalledWith(2222, 999);
      expect(grantRepo.getGrant("grant-recover")?.status).toBe("revoked");
    });

    it("does not touch a grant another revocation is actively working on", async () => {
      seedStrandedGrant("grant-inflight", freshLeaseStart());

      await buildService().revoke(grantRepo.getGrant("grant-inflight")!);

      expect(mockGithubClient.removeTeamMember).not.toHaveBeenCalled();
      expect(grantRepo.getGrant("grant-inflight")?.status).toBe("revoking");
    });

    it("stamps a lease when it takes a grant into revoking", async () => {
      const timestamp = new Date().toISOString();
      grantRepo.createGrant({
        id: "grant-lease",
        githubOrgId: 1111,
        targetTeamId: 2222,
        githubUserId: 999,
        githubLoginSnapshot: "octocat",
        status: "active",
        membershipCreatedByApp: 1,
        preexistingRole: null,
        grantedAt: timestamp,
        effectiveExpiresAt: expiredAt(),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      // Fail the removal so the grant stays mid-revocation and we can observe
      // the lease that was stamped on the way in.
      mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });
      mockGithubClient.removeTeamMember.mockRejectedValue(new Error("boom"));

      await buildService().revoke(grantRepo.getGrant("grant-lease")!);

      // Assert on the value, not merely "not null": an absent column reads as
      // undefined and would sail past a not-null check.
      expect(grantRepo.getGrant("grant-lease")?.revoking_started_at).toEqual(
        expect.any(String),
      );
    });
  });

  describe("reconciliation", () => {
    it("eventually revokes a grant stranded by a crash mid-revocation", async () => {
      seedStrandedGrant("grant-crashed", staleLeaseStart());
      mockGithubClient.getTeamMembership
        .mockResolvedValueOnce({ role: "member" })
        .mockResolvedValueOnce(null);

      const revocationService = new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );
      const reconciliation = new ReconciliationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        revocationService,
        mockOrgContext,
      );

      await reconciliation.reconcile();

      expect(mockGithubClient.removeTeamMember).toHaveBeenCalledWith(2222, 999);
      expect(grantRepo.getGrant("grant-crashed")?.status).toBe("revoked");
    });

    it("still revokes ordinary expired grants", async () => {
      const timestamp = new Date().toISOString();
      grantRepo.createGrant({
        id: "grant-normal",
        githubOrgId: 1111,
        targetTeamId: 2222,
        githubUserId: 999,
        githubLoginSnapshot: "octocat",
        status: "active",
        membershipCreatedByApp: 1,
        preexistingRole: null,
        grantedAt: timestamp,
        effectiveExpiresAt: expiredAt(),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      mockGithubClient.getTeamMembership
        .mockResolvedValueOnce({ role: "member" })
        .mockResolvedValueOnce(null);

      const revocationService = new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );
      const reconciliation = new ReconciliationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        revocationService,
        mockOrgContext,
      );

      await reconciliation.reconcile();

      expect(grantRepo.getGrant("grant-normal")?.status).toBe("revoked");
    });

    it("does not revoke a grant that has not expired yet", async () => {
      const timestamp = new Date().toISOString();
      grantRepo.createGrant({
        id: "grant-future",
        githubOrgId: 1111,
        targetTeamId: 2222,
        githubUserId: 999,
        githubLoginSnapshot: "octocat",
        status: "active",
        membershipCreatedByApp: 1,
        preexistingRole: null,
        grantedAt: timestamp,
        effectiveExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      const revocationService = new RevocationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        mockNotifier,
      );
      const reconciliation = new ReconciliationService(
        db,
        mockGithubClient as unknown as GitHubAccessProvider,
        revocationService,
        mockOrgContext,
      );

      await reconciliation.reconcile();

      expect(mockGithubClient.removeTeamMember).not.toHaveBeenCalled();
      expect(grantRepo.getGrant("grant-future")?.status).toBe("active");
    });
  });
});
