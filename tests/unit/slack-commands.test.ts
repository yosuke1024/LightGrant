import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import Database from "better-sqlite3";
import { handleLightGrantCommand } from "../../src/integrations/slack/commands.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import fs from "fs";
import path from "path";

describe("Slack Slash Command Handler", () => {
  const tempDbPath = path.resolve("./tests/slack-cmd-test.sqlite");
  let db: Database.Database;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    process.env.DATABASE_PATH = tempDbPath;
    process.env.APP_SECRET = "a".repeat(32);
    process.env.PUBLIC_BASE_URL = "https://example.com";
    db = new Database(tempDbPath);
    runMigrations(db);
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
    db.prepare("DELETE FROM oauth_states").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should respond with a connection link when the user is not linked", async () => {
    const ack = vi.fn();
    const respond = vi.fn();
    const client = {
      views: {
        open: vi.fn(),
      },
    };

    const command = {
      team_id: "W123",
      user_id: "U456",
      trigger_id: "trig-123",
      text: "request",
    };

    await handleLightGrantCommand({
      command,
      ack,
      respond,
      client: client as any,
      db,
    });

    expect(ack).toHaveBeenCalled();
    expect(respond).toHaveBeenCalled();
    const respondArg = respond.mock.calls[0][0];
    expect(respondArg.text).toContain("GitHub account connection is required");
    expect(respondArg.text).toContain("/auth/github/start?state=");

    // Verify oauth state was created in DB
    const states = db.prepare("SELECT * FROM oauth_states").all();
    expect(states).toHaveLength(1);
    expect(states[0].slack_workspace_id).toBe("W123");
    expect(states[0].slack_user_id).toBe("U456");
  });

  it("should open a request modal skeleton when the user is linked", async () => {
    const ack = vi.fn();
    const respond = vi.fn();
    const client = {
      views: {
        open: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    // Seed linked identity
    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "link-1",
      "W123",
      "U456",
      999,
      "github-user",
      new Date().toISOString(),
    );

    const command = {
      team_id: "W123",
      user_id: "U456",
      trigger_id: "trig-123",
      text: "request",
    };

    await handleLightGrantCommand({
      command,
      ack,
      respond,
      client: client as any,
      db,
    });

    expect(ack).toHaveBeenCalled();
    expect(client.views.open).toHaveBeenCalled();
    const openArg = client.views.open.mock.calls[0][0];
    expect(openArg.trigger_id).toBe("trig-123");
    expect(openArg.view.type).toBe("modal");
    expect(openArg.view.callback_id).toBe("request_modal_skeleton");
  });
});
