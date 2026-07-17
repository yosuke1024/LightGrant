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
import { RevocationService } from "../../src/services/revocation-service.js";
import { GrantService } from "../../src/services/grant-service.js";
import { JobWorker } from "../../src/workers/job-worker.js";
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { RequestRepository } from "../../src/persistence/repositories/request-repository.js";
import { JobRepository } from "../../src/persistence/repositories/job-repository.js";
import { SlackNotifier } from "../../src/services/slack-notifier.js";
import { GitHubAccessProvider } from "../../src/integrations/github/github-client.js";

/**
 * The revocation DELETE and a reactivating request can interleave so that the
 * membership ends up removed on GitHub while the DB believes the grant is
 * active. These tests drive the interleavings deterministically against a
 * stateful GitHub fake that actually tracks membership (member / absent), and
 * assert the invariant: the system never settles with the DB active/present
 * but the GitHub membership absent, and a zombie worker never overwrites the
 * new owner's state.
 */
describe("revoke / reactivation race", () => {
  const tempDbPath = path.resolve("./tests/revoke-reactivation-race.sqlite");
  let db: Database.Database;
  let grantRepo: GrantRepository;
  let identityRepo: IdentityRepository;
  let requestRepo: RequestRepository;
  let jobRepo: JobRepository;

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  const flush = async () => {
    // Yield both microtasks and a macrotask so awaited dynamic imports inside
    // the revocation flow settle before we inspect state.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      for (let j = 0; j < 20; j++) await Promise.resolve();
    }
  };

  /**
   * A GitHub fake that holds real membership state so removal/add actually
   * change what a later membership read observes.
   */
  class StatefulGitHub {
    role: "member" | "maintainer" | null = "member";
    orgState = "active";
    removeGate: Promise<void> | null = null;
    calls = { remove: 0, add: 0, getMembership: 0 };

    async resolveInstallation() {
      return {
        id: 5555,
        targetId: 1111,
        targetType: "Organization",
        accountLogin: "test-org",
      };
    }
    async getOrganizationMembership() {
      return { state: this.orgState, role: "member" };
    }
    async getTeamMembership() {
      this.calls.getMembership++;
      return this.role ? { role: this.role } : null;
    }
    async addTeamMember() {
      this.calls.add++;
      this.role = "member";
      return { role: "member" };
    }
    async removeTeamMember() {
      this.calls.remove++;
      if (this.removeGate) await this.removeGate;
      this.role = null;
    }
    async listTeams() {
      return [];
    }
  }

  const mockNotifier = {
    notifyRevocation: vi.fn().mockResolvedValue(undefined),
    postAuditRevocation: vi.fn().mockResolvedValue(undefined),
    notifyRequester: vi.fn().mockResolvedValue(undefined),
    postAuditLog: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackNotifier;

  const orgContext = {
    organizationId: 1111,
    organizationLogin: "test-org",
    installationId: 5555,
  };

  const expiredAt = () => new Date(Date.now() - 60_000).toISOString();
  const futureAt = () => new Date(Date.now() + 3_600_000).toISOString();

  const seedGrant = (
    id: string,
    status: string,
    effectiveExpiresAt: string,
  ) => {
    const ts = new Date().toISOString();
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
      effectiveExpiresAt,
      createdAt: ts,
      updatedAt: ts,
    });
    if (status !== "active") {
      db.prepare(`UPDATE grants SET status = ? WHERE id = ?`).run(status, id);
    }
  };

  const seedRequest = (id: string, durationMinutes: number) => {
    const ts = new Date().toISOString();
    requestRepo.createRequest({
      id,
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-1",
      targetTeamId: 2222,
      durationMinutes,
      reason: "reactivate",
      decisionStatus: "pending",
      requestedAt: ts,
      createdAt: ts,
      updatedAt: ts,
    });
  };

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) fs.unlinkSync(tempDbPath);
    db = new Database(tempDbPath);
    runMigrations(db);
    grantRepo = new GrantRepository(db);
    identityRepo = new IdentityRepository(db);
    requestRepo = new RequestRepository(db);
    jobRepo = new JobRepository(db);
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

  it("keeps a revoking grant in 'revoking' when a new request reactivates it", () => {
    seedGrant("grant-defer", "revoking", expiredAt());
    db.prepare(
      `UPDATE grants SET revoking_started_at = ?, revoking_lease_id = ? WHERE id = ?`,
    ).run(new Date().toISOString(), "lease-live", "grant-defer");

    seedRequest("req-defer", 60);
    new GrantService(db).createGrantIntentTx({
      requestId: "req-defer",
      decisionMode: "auto",
    });

    const grant = grantRepo.getGrant("grant-defer")!;
    // Must NOT flip to pending or clear the lease while a revocation may be
    // mid-DELETE; it records the intent and stays 'revoking'.
    expect(grant.status).toBe("revoking");
    expect(grant.revoking_lease_id).toBe("lease-live");
    expect(grant.membership_mutation_state).toBe("reactivation_required");

    // A grant_access job was enqueued to carry out the reactivation later.
    const jobs = jobRepo.acquireNextJobs("t", 5, 60);
    expect(jobs.some((j) => j.type === "grant_access")).toBe(true);
  });

  it("defers grant_access while the grant is still revoking", async () => {
    const fake = new StatefulGitHub();
    seedGrant("grant-wait", "revoking", futureAt());
    db.prepare(
      `UPDATE grants SET revoking_started_at = ?, revoking_lease_id = ?, membership_mutation_state = 'reactivation_required' WHERE id = ?`,
    ).run(new Date().toISOString(), "lease-live", "grant-wait");
    jobRepo.createJob({
      id: "job-wait",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-wait" }),
      runAfter: new Date().toISOString(),
    });

    const worker = new JobWorker(
      db,
      fake as unknown as GitHubAccessProvider,
      mockNotifier,
      orgContext,
    );
    await (worker as unknown as { runCycle(): Promise<void> }).runCycle();

    // Still revoking: no activation, no membership add.
    expect(grantRepo.getGrant("grant-wait")!.status).toBe("revoking");
    expect(fake.calls.add).toBe(0);
    // The job was not consumed permanently — it is queued again for later.
    const jobRow = db
      .prepare("SELECT status FROM jobs WHERE id = 'job-wait'")
      .get() as { status: string };
    expect(jobRow.status).toBe("queued");
  });

  it("a request arriving after DELETE starts still ends with membership present and DB active", async () => {
    const fake = new StatefulGitHub();
    fake.role = "member";
    const removeGate = deferred<void>();
    fake.removeGate = removeGate.promise;

    seedGrant("grant-race", "active", expiredAt());
    const revocation = new RevocationService(
      db,
      fake as unknown as GitHubAccessProvider,
      mockNotifier,
    );

    // Worker A begins revoking and parks inside removeTeamMember (DELETE
    // in flight, not yet applied).
    const workerA = revocation.revoke(grantRepo.getGrant("grant-race")!);
    await flush();
    expect(fake.calls.remove).toBe(1);
    expect(grantRepo.getGrant("grant-race")!.status).toBe("revoking");

    // A new request is approved through the real GrantService while the
    // DELETE is in flight.
    seedRequest("req-race", 60);
    new GrantService(db).createGrantIntentTx({
      requestId: "req-race",
      decisionMode: "auto",
    });
    expect(grantRepo.getGrant("grant-race")!.status).toBe("revoking");
    expect(grantRepo.getGrant("grant-race")!.membership_mutation_state).toBe(
      "reactivation_required",
    );

    // grant_access runs but must defer (still revoking) — no premature activate.
    const worker = new JobWorker(
      db,
      fake as unknown as GitHubAccessProvider,
      mockNotifier,
      orgContext,
    );
    await (worker as unknown as { runCycle(): Promise<void> }).runCycle();
    expect(grantRepo.getGrant("grant-race")!.status).toBe("revoking");

    // The DELETE completes: membership is now absent on GitHub.
    removeGate.resolve();
    await workerA;
    await flush();
    expect(fake.role).toBeNull();

    // Worker A must not have terminalized to 'revoked' with membership absent
    // and a reactivation pending; it hands the grant to reactivation.
    const afterA = grantRepo.getGrant("grant-race")!;
    expect(["pending", "revoked"]).toContain(afterA.status);
    expect(afterA.membership_mutation_state).toBe("reactivation_required");
    expect(afterA.revoked_at).toBeNull();

    // grant_access resumes and re-adds the membership.
    db.prepare(
      "UPDATE jobs SET run_after = ?, status = 'queued', locked_at = NULL, locked_by = NULL WHERE type = 'grant_access'",
    ).run(new Date().toISOString());
    await (worker as unknown as { runCycle(): Promise<void> }).runCycle();
    await (worker as unknown as { runCycle(): Promise<void> }).runCycle();

    // Final invariant: DB active AND membership present. Never active-with-absent.
    const final = grantRepo.getGrant("grant-race")!;
    expect(final.status).toBe("active");
    expect(fake.role).toBe("member");
    expect(fake.calls.add).toBe(1);
    // Request was approved.
    expect(requestRepo.getRequest("req-race")!.decision_status).toBe(
      "approved",
    );
  });

  it("recovers a grant stranded in revoking after a crash following DELETE", async () => {
    const fake = new StatefulGitHub();
    // The DELETE already happened before the crash: membership is absent.
    fake.role = null;

    // Reconstruct the post-crash state: grant stuck 'revoking' with a stale
    // lease, a reactivation already recorded, expiry extended to the future by
    // the new request, and a grant_access job waiting.
    seedGrant("grant-crash", "revoking", futureAt());
    const staleStart = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    db.prepare(
      `UPDATE grants SET revoking_started_at = ?, revoking_lease_id = ?, membership_mutation_state = 'reactivation_required' WHERE id = ?`,
    ).run(staleStart, "lease-dead", "grant-crash");
    seedRequest("req-crash", 60);
    grantRepo.createGrantRequest("grant-crash", "req-crash", futureAt());
    requestRepo.updateDecisionStatus(
      "req-crash",
      "approved",
      "auto",
      new Date().toISOString(),
      null,
    );
    jobRepo.createJob({
      id: "job-crash",
      type: "grant_access",
      payloadJson: JSON.stringify({ grantId: "grant-crash" }),
      runAfter: new Date().toISOString(),
    });

    // grant_access is the recovery driver: seeing a stranded 'revoking' grant
    // with a STALE lease and a pending reactivation, it takes over (the revoke
    // worker is dead), reactivates, and re-adds the membership — even though
    // the expiry was pushed into the future by the reactivating request.
    const worker = new JobWorker(
      db,
      fake as unknown as GitHubAccessProvider,
      mockNotifier,
      orgContext,
    );
    await (worker as unknown as { runCycle(): Promise<void> }).runCycle();

    const afterTakeover = grantRepo.getGrant("grant-crash")!;
    expect(afterTakeover.status).not.toBe("revoking");
    expect(afterTakeover.revoked_at).toBeNull();

    // Drive it to completion.
    db.prepare(
      "UPDATE jobs SET run_after = ?, status = 'queued', locked_at = NULL, locked_by = NULL WHERE type = 'grant_access'",
    ).run(new Date().toISOString());
    await (worker as unknown as { runCycle(): Promise<void> }).runCycle();
    await (worker as unknown as { runCycle(): Promise<void> }).runCycle();

    const final = grantRepo.getGrant("grant-crash")!;
    expect(final.status).toBe("active");
    expect(fake.role).toBe("member");
    expect(fake.calls.add).toBe(1);
  });
});
