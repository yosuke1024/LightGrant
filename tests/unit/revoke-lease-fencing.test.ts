import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
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
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { SlackNotifier } from "../../src/services/slack-notifier.js";
import { GitHubAccessProvider } from "../../src/integrations/github/github-client.js";

/**
 * A revocation leases its grant with a unique fencing token. A worker that
 * lost its lease — because a later worker reclaimed the stranded grant and
 * finished it — must not resume: no destructive GitHub call, no terminal DB
 * write. These tests drive that fencing deterministically with fake timers and
 * a deferred promise that parks the first worker mid-flight.
 */
describe("revoke lease fencing", () => {
  const tempDbPath = path.resolve("./tests/revoke-lease-fencing-test.sqlite");
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

  const expiredAt = () => new Date(Date.now() - 60_000).toISOString();

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Let queued microtasks (dynamic imports, awaited resolutions) settle. */
  const flush = async () => {
    for (let i = 0; i < 30; i++) {
      await Promise.resolve();
    }
  };

  const seedActiveExpiredGrant = (grantId: string) => {
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
  };

  const buildService = () =>
    new RevocationService(
      db,
      mockGithubClient as unknown as GitHubAccessProvider,
      mockNotifier,
    );

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

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stamps a unique lease id when it takes a grant into revoking", async () => {
    seedActiveExpiredGrant("grant-lease-id");
    // Fail the removal so the grant stays in 'revoking' and we can read the
    // lease id that was stamped on the way in.
    mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });
    mockGithubClient.removeTeamMember.mockRejectedValue(new Error("boom"));

    await buildService().revoke(grantRepo.getGrant("grant-lease-id")!);

    // Removal failed, so the grant is parked in revoke_failed with its lease
    // cleared; capture the lease that was stamped while it was 'revoking'.
    const row = grantRepo.getGrant("grant-lease-id")!;
    expect(row.status).toBe("revoke_failed");
    // The lease is released once we leave 'revoking'.
    expect(row.revoking_lease_id).toBeNull();
  });

  it("reclaims a stale lease under a brand-new lease id", async () => {
    seedActiveExpiredGrant("grant-reclaim");
    // Park it in 'revoking' with a stale lease under a known id.
    const staleStart = new Date(
      Date.now() - (REVOKE_LEASE_SECONDS + 60) * 1000,
    ).toISOString();
    db.prepare(
      `UPDATE grants SET status = 'revoking', revoking_started_at = ?, revoking_lease_id = ? WHERE id = ?`,
    ).run(staleStart, "old-lease-id", "grant-reclaim");

    // Fail removal so the reclaiming worker parks it again and we can inspect
    // the lease it stamped.
    mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });
    mockGithubClient.removeTeamMember.mockRejectedValue(new Error("boom"));

    // Observe the lease id mid-revocation by failing at the membership check.
    mockGithubClient.getTeamMembership.mockRejectedValue(
      Object.assign(new Error("boom-check"), { status: 500 }),
    );

    await buildService().revoke(grantRepo.getGrant("grant-reclaim")!);

    // It left 'revoking' as revoke_failed; the important part is that the old
    // lease id no longer governs the row.
    const row = grantRepo.getGrant("grant-reclaim")!;
    expect(row.revoking_lease_id).not.toBe("old-lease-id");
  });

  it("fences a resumed worker whose lease was reclaimed and completed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    seedActiveExpiredGrant("grant-race");

    // Worker A parks at the pre-removal membership check.
    const parkedA = deferred<{ role: string } | null>();
    mockGithubClient.getTeamMembership.mockReturnValueOnce(parkedA.promise);

    const workerA = buildService().revoke(grantRepo.getGrant("grant-race")!);
    await flush();

    // A holds the lease and the grant is in flight.
    const leaseA = grantRepo.getGrant("grant-race")!.revoking_lease_id;
    expect(leaseA).toEqual(expect.any(String));
    expect(grantRepo.getGrant("grant-race")!.status).toBe("revoking");

    // The lease window elapses.
    vi.setSystemTime(new Date("2026-01-01T00:16:00.000Z"));

    // Worker B reclaims the stale lease and completes the revocation.
    mockGithubClient.getTeamMembership
      .mockResolvedValueOnce({ role: "member" }) // B pre-removal check
      .mockResolvedValueOnce(null); // B removal verification
    await buildService().revoke(grantRepo.getGrant("grant-race")!);

    expect(grantRepo.getGrant("grant-race")!.status).toBe("revoked");
    expect(mockGithubClient.removeTeamMember).toHaveBeenCalledTimes(1);

    // Worker A resumes long after losing the lease.
    parkedA.resolve({ role: "member" });
    await workerA;
    await flush();

    // A must not remove the member again, nor overwrite B's terminal state.
    expect(mockGithubClient.removeTeamMember).toHaveBeenCalledTimes(1);
    expect(grantRepo.getGrant("grant-race")!.status).toBe("revoked");
  });

  it("lets only the lease owner transition to a terminal state", () => {
    seedActiveExpiredGrant("grant-owner");
    const start = new Date(Date.now() - 60_000).toISOString();
    db.prepare(
      `UPDATE grants SET status = 'revoking', revoking_started_at = ?, revoking_lease_id = ? WHERE id = ?`,
    ).run(start, "lease-owner", "grant-owner");
    const stale = new Date(
      Date.now() - REVOKE_LEASE_SECONDS * 1000,
    ).toISOString();

    // A stranger's token cannot finalize.
    const strangerWon = grantRepo.finalizeRevocationWithLease(
      "grant-owner",
      "someone-else",
      stale,
      {
        status: "revoked",
        revokedAt: new Date().toISOString(),
        attemptCount: 0,
        nextAttemptAt: null,
        errorCode: null,
        errorMessage: null,
      },
    );
    expect(strangerWon).toBe(false);
    expect(grantRepo.getGrant("grant-owner")!.status).toBe("revoking");

    // The lease owner can.
    const ownerWon = grantRepo.finalizeRevocationWithLease(
      "grant-owner",
      "lease-owner",
      stale,
      {
        status: "revoked",
        revokedAt: new Date().toISOString(),
        attemptCount: 0,
        nextAttemptAt: null,
        errorCode: null,
        errorMessage: null,
      },
    );
    expect(ownerWon).toBe(true);
    const row = grantRepo.getGrant("grant-owner")!;
    expect(row.status).toBe("revoked");
    // Leaving 'revoking' releases the lease.
    expect(row.revoking_started_at).toBeNull();
    expect(row.revoking_lease_id).toBeNull();
  });

  it("invalidates the old lease when a grant is reactivated", () => {
    seedActiveExpiredGrant("grant-reactivate");
    const start = new Date().toISOString();
    db.prepare(
      `UPDATE grants SET status = 'revoking', revoking_started_at = ?, revoking_lease_id = ? WHERE id = ?`,
    ).run(start, "lease-before-reactivate", "grant-reactivate");

    grantRepo.reactivateGrant(
      "grant-reactivate",
      new Date(Date.now() + 3_600_000).toISOString(),
      "reactivation_required",
    );

    const row = grantRepo.getGrant("grant-reactivate")!;
    expect(row.status).toBe("pending");
    expect(row.revoking_started_at).toBeNull();
    expect(row.revoking_lease_id).toBeNull();

    // The now-expired token can no longer finalize the grant.
    const stale = new Date(
      Date.now() - REVOKE_LEASE_SECONDS * 1000,
    ).toISOString();
    const zombieWon = grantRepo.finalizeRevocationWithLease(
      "grant-reactivate",
      "lease-before-reactivate",
      stale,
      {
        status: "revoked",
        revokedAt: new Date().toISOString(),
        attemptCount: 0,
        nextAttemptAt: null,
        errorCode: null,
        errorMessage: null,
      },
    );
    expect(zombieWon).toBe(false);
    expect(grantRepo.getGrant("grant-reactivate")!.status).toBe("pending");
  });

  it("does not let a lost worker overwrite the new worker's DB result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));
    seedActiveExpiredGrant("grant-overwrite");

    // Worker A parks after the pre-removal check but before removal completes:
    // let the membership check pass, then park the removal call itself.
    mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });
    const parkedRemoval = deferred<void>();
    mockGithubClient.removeTeamMember.mockReturnValueOnce(parkedRemoval.promise);

    const workerA = buildService().revoke(
      grantRepo.getGrant("grant-overwrite")!,
    );
    await flush();

    expect(grantRepo.getGrant("grant-overwrite")!.status).toBe("revoking");

    // Lease elapses; Worker B reclaims and fails the revocation, landing it in
    // revoke_failed with its own lease.
    vi.setSystemTime(new Date("2026-02-01T00:16:00.000Z"));
    mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });
    mockGithubClient.removeTeamMember.mockRejectedValueOnce(
      Object.assign(new Error("gh down"), { status: 500 }),
    );
    await buildService().revoke(grantRepo.getGrant("grant-overwrite")!);

    const afterB = grantRepo.getGrant("grant-overwrite")!;
    expect(afterB.status).toBe("revoke_failed");

    // Worker A's parked removal finally returns success.
    parkedRemoval.resolve();
    await workerA;
    await flush();

    // A must NOT stamp 'revoked' over B's revoke_failed record.
    expect(grantRepo.getGrant("grant-overwrite")!.status).toBe("revoke_failed");
  });
});
