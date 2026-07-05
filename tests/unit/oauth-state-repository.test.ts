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
});
