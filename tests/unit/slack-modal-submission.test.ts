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
import {
  handleTeamOptionsLoad,
  handleOptionsLoad,
  handleRequestModalSubmission,
} from "../../src/integrations/slack/commands.js";
import { TeamRepository } from "../../src/persistence/repositories/team-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { RequestRepository } from "../../src/persistence/repositories/request-repository.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import fs from "fs";
import path from "path";

describe("Slack Modal & Dynamic Select Handlers", () => {
  const tempDbPath = path.resolve("./tests/slack-modal-test.sqlite");
  let db: Database.Database;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
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
    db.prepare("DELETE FROM approvals").run();
    db.prepare("DELETE FROM access_requests").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("DELETE FROM github_teams").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("handleTeamOptionsLoad should return matching teams from cache", async () => {
    const teamRepo = new TeamRepository(db);
    const timestamp = new Date().toISOString();
    teamRepo.upsertTeams(
      1111,
      [
        {
          id: 101,
          name: "frontend-team",
          slug: "frontend-team",
          description: "",
          privacy: "closed",
        },
        {
          id: 102,
          name: "backend-team",
          slug: "backend-team",
          description: "",
          privacy: "closed",
        },
        {
          id: 103,
          name: "infra-team",
          slug: "infra-team",
          description: "",
          privacy: "closed",
        },
      ],
      timestamp,
    );

    const ack = vi.fn();

    // User types "front"
    await handleTeamOptionsLoad({
      options: { value: "front" },
      ack,
      db,
    });

    expect(ack).toHaveBeenCalled();
    const ackArg = ack.mock.calls[0][0];
    expect(ackArg.options).toHaveLength(1);
    expect(ackArg.options[0].text.text).toBe("frontend-team");
    expect(ackArg.options[0].value).toBe("101");
  });

  describe("handleOptionsLoad routing", () => {
    const seedIdpTeam = (): void => {
      const teamRepo = new TeamRepository(db);
      teamRepo.upsertTeams(
        1111,
        [
          {
            id: 201,
            name: "sso-team",
            slug: "sso-team",
            description: "",
            privacy: "closed",
          },
        ],
        new Date().toISOString(),
      );
      teamRepo.setSynchronizedFlag(201, true);
    };

    it("serves the team cache for the request modal target select", async () => {
      seedIdpTeam();
      const ack = vi.fn();

      await handleOptionsLoad({
        options: { value: "sso", action_id: "team_select" },
        ack,
        db,
      });

      const ackArg = ack.mock.calls[0][0];
      expect(ackArg.options).toHaveLength(1);
      expect(ackArg.options[0].value).toBe("201");
    });

    it("marks IdP-managed teams as unsupported for grant target selects", async () => {
      seedIdpTeam();
      const ack = vi.fn();

      await handleOptionsLoad({
        options: { value: "sso", action_id: "policy_target_team_select" },
        ack,
        db,
      });

      expect(ack.mock.calls[0][0].options[0].text.text).toBe(
        "sso-team (IdP managed — unsupported)",
      );
    });

    it("does not mark IdP-managed teams for requester eligibility selects", async () => {
      // Requester eligibility only reads membership, so an IdP-synchronized
      // team is perfectly usable here and must not be labelled unsupported.
      seedIdpTeam();
      const ack = vi.fn();

      await handleOptionsLoad({
        options: { value: "sso", action_id: "policy_requester_teams_select" },
        ack,
        db,
      });

      expect(ack.mock.calls[0][0].options[0].text.text).toBe("sso-team");
    });

    it("returns no options for an unregistered select instead of the team list", async () => {
      seedIdpTeam();
      const ack = vi.fn();

      await handleOptionsLoad({
        options: { value: "sso", action_id: "repository_select" },
        ack,
        db,
      });

      expect(ack.mock.calls[0][0].options).toEqual([]);
    });

    it("returns no options when action_id is absent", async () => {
      seedIdpTeam();
      const ack = vi.fn();

      await handleOptionsLoad({ options: { value: "sso" }, ack, db });

      expect(ack.mock.calls[0][0].options).toEqual([]);
    });
  });

  it("handleRequestModalSubmission should save request and trigger notifier", async () => {
    const timestamp = new Date().toISOString();
    // Seed identity link for requester U456
    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "identity-req",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    // Seed team in cache
    const teamRepo = new TeamRepository(db);
    teamRepo.upsertTeams(
      1111,
      [
        {
          id: 101,
          name: "frontend-team",
          slug: "frontend-team",
          description: "",
          privacy: "closed",
        },
      ],
      timestamp,
    );

    // Mock Slack modal view payload
    const view = {
      state: {
        values: {
          team_block: {
            team_select: {
              selected_option: {
                value: "101",
                text: { text: "frontend-team" },
              },
            },
          },
          duration_block: {
            duration_select: {
              selected_option: { value: "60" },
            },
          },
          reason_block: {
            reason_input: {
              value: "Need to deploy hotfix",
            },
          },
        },
      },
    };

    const body = {
      user: { id: "U456", team_id: "W123" },
    };

    const ack = vi.fn();
    const notifier = {
      postManualApproval: vi
        .fn()
        .mockResolvedValue({ channelId: "C888", messageTs: "12345.67" }),
      updateApprovalMessage: vi.fn(),
      notifyRequester: vi.fn(),
      postAuditLog: vi.fn().mockResolvedValue(undefined),
    };

    await handleRequestModalSubmission({
      view: view as any,
      body: body as any,
      ack,
      db,
      notifier,
      githubClient: {
        getOrganizationMembership: vi
          .fn()
          .mockResolvedValue({ state: "active", role: "member" }),
      } as any,
    });

    expect(ack).toHaveBeenCalled();
    expect(notifier.postManualApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        slackUserId: "U456",
        githubLogin: "octocat",
        teamName: "frontend-team",
        durationMinutes: 60,
        reason: "Need to deploy hotfix",
      }),
    );

    // Verify DB request creation
    const requestRepo = new RequestRepository(db);
    const requests = db.prepare("SELECT * FROM access_requests").all();
    expect(requests).toHaveLength(1);
    expect(requests[0].target_team_id).toBe(101);
    expect(requests[0].slack_approval_channel_id).toBe("C888");
    expect(requests[0].slack_approval_message_ts).toBe("12345.67");
  });
});
