import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";

describe("IdentityRepository", () => {
  const tempDbPath = path.resolve("./tests/identity-repo-test.sqlite");
  let db: Database.Database;
  let repository: IdentityRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    repository = new IdentityRepository(db);
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
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should create and retrieve identity links", () => {
    const timestamp = new Date().toISOString();
    repository.createLink(
      "link-1",
      "W123",
      "U456",
      999,
      "github-user",
      timestamp,
    );

    const link = repository.getLinkBySlackUser("W123", "U456");
    expect(link).toBeDefined();
    expect(link?.id).toBe("link-1");
    expect(link?.github_login).toBe("github-user");
    expect(link?.unlinked_at).toBeNull();

    const linkByGitHub = repository.getLinkByGitHubUser("W123", 999);
    expect(linkByGitHub?.id).toBe("link-1");
  });

  it("should unlink identity links", () => {
    const timestamp = new Date().toISOString();
    repository.createLink(
      "link-1",
      "W123",
      "U456",
      999,
      "github-user",
      timestamp,
    );

    repository.unlink("W123", "U456", timestamp);

    const link = repository.getLinkBySlackUser("W123", "U456");
    expect(link).toBeNull();
  });
});
