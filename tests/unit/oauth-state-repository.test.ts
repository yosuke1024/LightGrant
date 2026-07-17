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

    repository.markAsUsed("state-1", timestamp);
    const stateAfter = repository.getState("state-1");
    expect(stateAfter?.used_at).toBe(timestamp);
  });

  it("should record the OIDC nonce hash for the Slack leg", () => {
    const ts = new Date().toISOString();
    repository.createState(
      "state-oidc",
      "nonce-oidc",
      "W1",
      "U1",
      null,
      null,
      new Date(Date.now() + 600000).toISOString(),
      ts,
    );

    repository.setOidcNonceHash("state-oidc", "oidc-hash-abc");
    expect(repository.getState("state-oidc")?.oidc_nonce_hash).toBe(
      "oidc-hash-abc",
    );
  });

  it("markSlackVerified stores the binding hash once and is idempotent", () => {
    const ts = new Date().toISOString();
    repository.createState(
      "state-bind",
      "nonce-bind",
      "W1",
      "U1",
      null,
      null,
      new Date(Date.now() + 600000).toISOString(),
      ts,
    );

    const first = repository.markSlackVerified("state-bind", ts, "bind-hash-1");
    expect(first).toBe(true);
    const row = repository.getState("state-bind");
    expect(row?.slack_verified_at).toBe(ts);
    expect(row?.binding_token_hash).toBe("bind-hash-1");

    // A second attempt must not overwrite the binding for an already-verified flow.
    const second = repository.markSlackVerified(
      "state-bind",
      ts,
      "bind-hash-2",
    );
    expect(second).toBe(false);
    expect(repository.getState("state-bind")?.binding_token_hash).toBe(
      "bind-hash-1",
    );
  });

  it("markAsUsed clears the binding token hash so the cookie cannot re-link", () => {
    const ts = new Date().toISOString();
    repository.createState(
      "state-consume",
      "nonce-consume",
      "W1",
      "U1",
      null,
      null,
      new Date(Date.now() + 600000).toISOString(),
      ts,
    );
    repository.markSlackVerified("state-consume", ts, "bind-hash");

    repository.markAsUsed("state-consume", ts);
    const row = repository.getState("state-consume");
    expect(row?.used_at).toBe(ts);
    expect(row?.binding_token_hash).toBeNull();
  });
});
