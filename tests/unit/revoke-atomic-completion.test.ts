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
import { GitHubAccessProvider } from "../../src/integrations/github/github-client.js";

/**
 * A successful revocation (membership removed or already absent) must decide
 * "revoked" vs "hand back to reactivation" ATOMICALLY. If the reactivation
 * check and the terminal 'revoked' write are separate operations, a request
 * that lands between them strands the grant: 'revoked' with revoked_at set,
 * yet a reactivation re-adds the membership and clears nothing — so the grant
 * escapes getExpiredGrants() forever (JIT access becomes permanent).
 *
 * These tests pin the atomic contract at both the repository and service
 * layers.
 */
describe("atomic successful-revoke completion", () => {
  const tempDbPath = path.resolve("./tests/revoke-atomic-completion.sqlite");
  let db: Database.Database;
  let grantRepo: GrantRepository;
  let identityRepo: IdentityRepository;

  const mockNotifier = {
    notifyRevocation: vi.fn().mockResolvedValue(undefined),
    postAuditRevocation: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackNotifier;

  const liveLease = "lease-live";
  const nowIso = () => new Date().toISOString();

  /** Seed an active grant whose expiry is already in the past. */
  const seedActiveExpired = (id: string) => {
    const ts = nowIso();
    grantRepo.createGrant({
      id,
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: ts,
      effectiveExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: ts,
      updatedAt: ts,
    });
  };

  /** Seed a grant already parked in 'revoking' with a fresh, live lease. */
  const seedRevoking = (
    id: string,
    opts: { mutationState?: string; leaseId?: string; startedAt?: string } = {},
  ) => {
    const ts = nowIso();
    grantRepo.createGrant({
      id,
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: ts,
      effectiveExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: ts,
      updatedAt: ts,
    });
    db.prepare(
      `UPDATE grants
         SET status = 'revoking',
             revoking_started_at = ?,
             revoking_lease_id = ?,
             membership_mutation_state = ?
       WHERE id = ?`,
    ).run(
      opts.startedAt ?? ts,
      opts.leaseId ?? liveLease,
      opts.mutationState ?? "not_started",
      id,
    );
  };

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    db = new Database(tempDbPath);
    runMigrations(db);
    grantRepo = new GrantRepository(db);
    identityRepo = new IdentityRepository(db);
  });

  afterAll(() => {
    if (db) db.close();
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    db.prepare("PRAGMA foreign_keys = OFF").run();
    for (const t of [
      "grants",
      "identity_links",
      "grant_requests",
      "access_requests",
      "jobs",
      "audit_events",
      "approvals",
    ]) {
      db.prepare(`DELETE FROM ${t}`).run();
    }
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  // ---- Repository-level: the atomic decision itself ----

  it("finalizeSuccessfulRevoke marks 'revoked' when no reactivation is pending", () => {
    seedRevoking("g-revoked");
    const revokedAt = nowIso();

    const outcome = grantRepo.finalizeSuccessfulRevoke(
      "g-revoked",
      liveLease,
      new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      revokedAt,
    );

    expect(outcome).toBe("revoked");
    const g = grantRepo.getGrant("g-revoked")!;
    expect(g.status).toBe("revoked");
    expect(g.revoked_at).toBe(revokedAt);
    expect(g.revoking_lease_id).toBeNull();
    expect(g.revoking_started_at).toBeNull();
  });

  it("finalizeSuccessfulRevoke hands back (no revoked_at) when reactivation is pending", () => {
    seedRevoking("g-react", { mutationState: "reactivation_required" });

    const outcome = grantRepo.finalizeSuccessfulRevoke(
      "g-react",
      liveLease,
      new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      nowIso(),
    );

    expect(outcome).toBe("reactivation_pending");
    const g = grantRepo.getGrant("g-react")!;
    expect(g.status).toBe("pending");
    expect(g.membership_mutation_state).toBe("reactivation_required");
    // The invariant the blocker is about: a handed-back grant NEVER carries a
    // revoked_at, so getExpiredGrants() can still reclaim it.
    expect(g.revoked_at).toBeNull();
    expect(g.revoking_lease_id).toBeNull();
  });

  it("finalizeSuccessfulRevoke reports lease_lost when the fencing token no longer matches", () => {
    seedRevoking("g-lost", { leaseId: "someone-elses-lease" });

    const outcome = grantRepo.finalizeSuccessfulRevoke(
      "g-lost",
      liveLease,
      new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      nowIso(),
    );

    expect(outcome).toBe("lease_lost");
    // Untouched: still revoking under the other owner's lease.
    const g = grantRepo.getGrant("g-lost")!;
    expect(g.status).toBe("revoking");
    expect(g.revoking_lease_id).toBe("someone-elses-lease");
  });

  it("finalizeSuccessfulRevoke reports lease_lost when the lease has gone stale", () => {
    const staleStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    seedRevoking("g-stale", { startedAt: staleStart });

    const outcome = grantRepo.finalizeSuccessfulRevoke(
      "g-stale",
      liveLease,
      new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      nowIso(),
    );

    expect(outcome).toBe("lease_lost");
    expect(grantRepo.getGrant("g-stale")!.status).toBe("revoking");
  });

  // ---- Service-level: the TOCTOU the blocker describes ----

  it("hands the grant back (never strands it 'revoked') when a request reactivates it during the absent-membership check", async () => {
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      nowIso(),
    );
    seedActiveExpired("g-toctou");

    // Membership is absent on GitHub (path 3.1). A reactivating request lands
    // exactly at the check boundary — after the lease is taken, before the
    // terminal write — which the atomic finalize must observe and honour.
    const fakeGithub = {
      getTeamMembership: vi.fn().mockImplementationOnce(async () => {
        db.prepare(
          `UPDATE grants SET membership_mutation_state = 'reactivation_required' WHERE id = ?`,
        ).run("g-toctou");
        return null;
      }),
      removeTeamMember: vi.fn(),
    } as unknown as GitHubAccessProvider;

    const service = new RevocationService(db, fakeGithub, mockNotifier);
    await service.revoke(grantRepo.getGrant("g-toctou")!);

    const g = grantRepo.getGrant("g-toctou")!;
    // Must be handed back, not finalized 'revoked' with a stranding revoked_at.
    expect(g.status).toBe("pending");
    expect(g.revoked_at).toBeNull();
    expect(g.membership_mutation_state).toBe("reactivation_required");

    // A hand-back audit event was written; NO grant_revoked event.
    const handBack = db
      .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event_type = ?")
      .get("revoke.handed_back_to_reactivation") as { c: number };
    const revoked = db
      .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event_type = ?")
      .get("grant_revoked") as { c: number };
    expect(handBack.c).toBe(1);
    expect(revoked.c).toBe(0);

    // No 'revoked' user notification was queued for a grant being restored.
    const notifyJobs = db
      .prepare("SELECT COUNT(*) AS c FROM jobs WHERE type = ?")
      .get("notify_request_result") as { c: number };
    expect(notifyJobs.c).toBe(0);
  });

  it("finalizes 'revoked' with notifications when no reactivation is pending (absent membership)", async () => {
    identityRepo.createLink(
      "identity-2",
      "W123",
      "U456",
      999,
      "octocat",
      nowIso(),
    );
    seedActiveExpired("g-clean");

    const fakeGithub = {
      getTeamMembership: vi.fn().mockResolvedValue(null),
      removeTeamMember: vi.fn(),
    } as unknown as GitHubAccessProvider;

    const service = new RevocationService(db, fakeGithub, mockNotifier);
    await service.revoke(grantRepo.getGrant("g-clean")!);

    const g = grantRepo.getGrant("g-clean")!;
    expect(g.status).toBe("revoked");
    expect(g.revoked_at).not.toBeNull();

    const revoked = db
      .prepare("SELECT COUNT(*) AS c FROM audit_events WHERE event_type = ?")
      .get("grant_revoked") as { c: number };
    expect(revoked.c).toBe(1);
    const notifyJobs = db
      .prepare("SELECT COUNT(*) AS c FROM jobs WHERE type = ?")
      .get("notify_request_result") as { c: number };
    expect(notifyJobs.c).toBe(1);
  });
});
