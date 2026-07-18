import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { OAuthStateRepository } from "../../src/persistence/repositories/oauth-state-repository.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";

describe("OAuthStateRepository", () => {
  const tempDbPath = path.resolve("./tests/oauth-state-repo-test.sqlite");
  let db: Database.Database;
  let repository: OAuthStateRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    repository = new OAuthStateRepository(db);
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
    db.prepare("DELETE FROM oauth_states").run();
  });

  it("should create and retrieve oauth states", () => {
    const timestamp = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 600000).toISOString(); // 10 mins
    repository.createState(
      "state-1",
      "hashed-nonce",
      "W123",
      "U456",
      "button_click",
      "btn-123",
      expiresAt,
      timestamp,
    );

    const state = repository.getState("state-1");
    expect(state).toBeDefined();
    expect(state?.id).toBe("state-1");
    expect(state?.nonce_hash).toBe("hashed-nonce");
    expect(state?.used_at).toBeNull();

    const stateByNonce = repository.getStateByNonceHash("hashed-nonce");
    expect(stateByNonce?.id).toBe("state-1");
  });

  const future = () => new Date(Date.now() + 600000).toISOString();
  const past = () => new Date(Date.now() - 1000).toISOString();
  const seed = (id: string, expiresAt: string) =>
    repository.createState(
      id,
      `nonce-${id}`,
      "W1",
      "U1",
      null,
      null,
      expiresAt,
      new Date().toISOString(),
    );

  describe("beginSlackOidc (CAS: unstarted -> oidc_pending)", () => {
    it("sets the nonce hash exactly once and never overwrites it", () => {
      seed("s-begin", future());
      const now = new Date().toISOString();

      expect(repository.beginSlackOidc("s-begin", "hash-A", now)).toBe(true);
      expect(repository.getState("s-begin")?.oidc_nonce_hash).toBe("hash-A");

      // A second start must not overwrite the pending nonce.
      expect(repository.beginSlackOidc("s-begin", "hash-B", now)).toBe(false);
      expect(repository.getState("s-begin")?.oidc_nonce_hash).toBe("hash-A");
    });

    it("refuses to start an expired state", () => {
      seed("s-begin-exp", past());
      expect(
        repository.beginSlackOidc(
          "s-begin-exp",
          "hash",
          new Date().toISOString(),
        ),
      ).toBe(false);
      expect(repository.getState("s-begin-exp")?.oidc_nonce_hash).toBeNull();
    });
  });

  describe("completeSlackVerification (CAS: oidc_pending -> slack_verified)", () => {
    it("fails closed when no OIDC nonce hash was ever recorded", () => {
      seed("s-nononce", future());
      const now = new Date().toISOString();

      const ok = repository.completeSlackVerification(
        "s-nononce",
        "any-hash",
        "bind-hash",
        now,
        now,
      );
      expect(ok).toBe(false);
      const row = repository.getState("s-nononce");
      expect(row?.slack_verified_at).toBeNull();
      expect(row?.binding_token_hash).toBeNull();
    });

    it("fails on a mismatched (stale) nonce hash", () => {
      seed("s-stale", future());
      const now = new Date().toISOString();
      repository.beginSlackOidc("s-stale", "expected-hash", now);

      expect(
        repository.completeSlackVerification(
          "s-stale",
          "wrong-hash",
          "bind-hash",
          now,
          now,
        ),
      ).toBe(false);
      expect(repository.getState("s-stale")?.slack_verified_at).toBeNull();
    });

    it("succeeds on a matching nonce, clears it, and is idempotent", () => {
      seed("s-match", future());
      const now = new Date().toISOString();
      repository.beginSlackOidc("s-match", "expected-hash", now);

      const first = repository.completeSlackVerification(
        "s-match",
        "expected-hash",
        "bind-hash-1",
        now,
        now,
      );
      expect(first).toBe(true);
      const row = repository.getState("s-match");
      expect(row?.slack_verified_at).toBe(now);
      expect(row?.binding_token_hash).toBe("bind-hash-1");
      // The nonce is consumed so a replayed code cannot re-verify.
      expect(row?.oidc_nonce_hash).toBeNull();

      // A second completion cannot re-drive an already-verified flow.
      const second = repository.completeSlackVerification(
        "s-match",
        "expected-hash",
        "bind-hash-2",
        now,
        now,
      );
      expect(second).toBe(false);
      expect(repository.getState("s-match")?.binding_token_hash).toBe(
        "bind-hash-1",
      );
    });
  });

  describe("consumeVerifiedState (CAS: slack_verified -> consumed)", () => {
    const prepareVerified = (id: string, expiresAt: string) => {
      seed(id, expiresAt);
      const now = new Date().toISOString();
      repository.beginSlackOidc(id, "n-hash", now);
      repository.completeSlackVerification(id, "n-hash", "bind-hash", now, now);
    };

    it("consumes exactly once and clears the binding hash (one-time)", () => {
      prepareVerified("s-consume", future());
      const firstAt = "2026-01-01T00:00:00.000Z";
      const secondAt = "2026-02-02T00:00:00.000Z";
      const now = new Date().toISOString();

      const first = repository.consumeVerifiedState(
        "s-consume",
        "bind-hash",
        firstAt,
        now,
      );
      expect(first).toBe(true);

      const second = repository.consumeVerifiedState(
        "s-consume",
        "bind-hash",
        secondAt,
        now,
      );
      expect(second).toBe(false);

      const row = repository.getState("s-consume");
      expect(row?.binding_token_hash).toBeNull();
      // used_at must reflect the winner, not be overwritten by the loser.
      expect(row?.used_at).toBe(firstAt);
    });

    it("refuses a wrong binding hash", () => {
      prepareVerified("s-wrongbind", future());
      const now = new Date().toISOString();
      expect(
        repository.consumeVerifiedState("s-wrongbind", "not-it", now, now),
      ).toBe(false);
      expect(repository.getState("s-wrongbind")?.used_at).toBeNull();
    });

    it("refuses a state that was never Slack-verified", () => {
      seed("s-unverified", future());
      const now = new Date().toISOString();
      expect(
        repository.consumeVerifiedState("s-unverified", "bind-hash", now, now),
      ).toBe(false);
    });

    it("refuses an expired verified state", () => {
      prepareVerified("s-consume-exp", past());
      const now = new Date().toISOString();
      expect(
        repository.consumeVerifiedState("s-consume-exp", "bind-hash", now, now),
      ).toBe(false);
      expect(repository.getState("s-consume-exp")?.used_at).toBeNull();
    });
  });
});
