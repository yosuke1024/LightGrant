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
import crypto from "crypto";
import { handleRequestModalSubmission } from "../../src/integrations/slack/commands.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { TeamRepository } from "../../src/persistence/repositories/team-repository.js";
import { PolicyRepository } from "../../src/persistence/repositories/policy-repository.js";
import { RequestRepository } from "../../src/persistence/repositories/request-repository.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import { JobWorker } from "../../src/workers/job-worker.js";
import { createTestPolicy } from "../helpers/create-test-policy.js";

describe("Slack Auto-Approval Flow", () => {
  const tempDbPath = path.resolve("./tests/slack-auto-approval-test.sqlite");
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
    db.prepare("DELETE FROM policies").run();
    db.prepare("DELETE FROM policy_versions").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("DELETE FROM github_teams").run();
    db.prepare("DELETE FROM access_requests").run();
    db.prepare("DELETE FROM grants").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should auto-approve, add member, record grant, and post audit log when policy criteria met", async () => {
    const timestamp = new Date().toISOString();

    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "id-req-1",
      "W123",
      "U-req-1",
      101,
      "req-git-1",
      timestamp,
    );

    const teamRepo = new TeamRepository(db);
    teamRepo.upsertTeams(
      1111,
      [
        {
          id: 200,
          name: "auto-team",
          slug: "auto-team",
          description: "",
          privacy: "closed",
        },
      ],
      timestamp,
    );

    identityRepo.createLink(
      "id-creator",
      "W123",
      "U-creator",
      999,
      "creator-git",
      timestamp,
    );

    createTestPolicy(db, {
      id: "pol-auto-1",
      version: 1,
      target_team_id: 200,
      max_duration_minutes: 120,
      snapshot_json: JSON.stringify({
        effect: "auto_approve",
        requester_team_ids: [300],
        max_duration_minutes: 120,
        reason_required: true,
      }),
      slack_workspace_id: "W123",
      github_org_id: 1111,
      created_by_identity_id: "id-creator",
    });

    const view = {
      callback_id: "request_modal_skeleton",
      private_metadata: "C-allowed-1",
      state: {
        values: {
          team_block: {
            team_select: {
              selected_option: { value: "200", text: { text: "auto-team" } },
            },
          },
          duration_block: {
            duration_select: {
              selected_option: { value: "60", text: { text: "60 minutes" } },
            },
          },
          reason_block: {
            reason_input: {
              value: "Need access for quick bug fix",
            },
          },
        },
      },
    };

    const body = {
      user: {
        team_id: "W123",
        id: "U-req-1",
      },
    };

    const ack = vi.fn();
    const notifier = {
      postManualApproval: vi.fn(),
      updateApprovalMessage: vi.fn(),
      notifyRequester: vi.fn().mockResolvedValue(undefined),
      postAuditLog: vi.fn().mockResolvedValue(undefined),
    };

    let memberChecked = false;
    const githubClient = {
      getOrganizationMembership: vi.fn().mockResolvedValue({
        state: "active",
        role: "member",
      }),
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (teamId === 300 && userId === 101) {
          return { teamId: 300, githubUserId: 101, role: "member" };
        }
        if (teamId === 200 && userId === 999) {
          return { teamId: 200, githubUserId: 999, role: "maintainer" };
        }
        if (teamId === 200 && userId === 101) {
          if (!memberChecked) {
            memberChecked = true;
            const err = new Error("Not Found");
            err.name = "GitHubNotFoundError";
            throw err;
          }
          return { role: "member" };
        }
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
      addTeamMember: vi.fn().mockResolvedValue({ role: "member" }),
    };

    await handleRequestModalSubmission({
      view,
      body,
      ack,
      db,
      notifier: notifier as any,
      githubClient: githubClient as any,
    });

    const worker = new JobWorker(db, githubClient, notifier as any);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    expect(ack).toHaveBeenCalled();

    const requests = db.prepare("SELECT * FROM access_requests").all() as any[];
    expect(requests).toHaveLength(1);
    expect(requests[0].decision_status).toBe("approved");
    expect(requests[0].decision_mode).toBe("auto");
    expect(requests[0].matched_policy_id).toBe("pol-auto-1");
    expect(requests[0].matched_policy_version).toBe(1);

    const grants = db.prepare("SELECT * FROM grants").all() as any[];
    expect(grants).toHaveLength(1);
    expect(grants[0].status).toBe("active");
    expect(grants[0].membership_created_by_app).toBe(1);

    expect(githubClient.addTeamMember).toHaveBeenCalledWith(200, 101);
    expect(notifier.postManualApproval).not.toHaveBeenCalled();

    const events = db
      .prepare("SELECT * FROM audit_events WHERE event_type = ?")
      .all("policy.evaluated") as any[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload_json);
    expect(payload.selected_policy_id).toBe("pol-auto-1");
    expect(payload.is_auto_approved).toBe(true);
    expect(payload.evaluated_policy_results[0].matched).toBe(true);
  });

  it("should protect preexisting membership by setting membershipCreatedByApp = 0 during auto-approve", async () => {
    const timestamp = new Date().toISOString();

    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "id-req-2",
      "W123",
      "U-req-2",
      102,
      "req-git-2",
      timestamp,
    );

    const teamRepo = new TeamRepository(db);
    teamRepo.upsertTeams(
      1111,
      [
        {
          id: 200,
          name: "auto-team",
          slug: "auto-team",
          description: "",
          privacy: "closed",
        },
      ],
      timestamp,
    );

    identityRepo.createLink(
      "id-creator",
      "W123",
      "U-creator",
      999,
      "creator-git",
      timestamp,
    );

    createTestPolicy(db, {
      id: "pol-auto-1",
      version: 1,
      target_team_id: 200,
      max_duration_minutes: 120,
      snapshot_json: JSON.stringify({
        effect: "auto_approve",
        requester_team_ids: [300],
        max_duration_minutes: 120,
        reason_required: true,
      }),
      slack_workspace_id: "W123",
      github_org_id: 1111,
      created_by_identity_id: "id-creator",
    });

    const view = {
      callback_id: "request_modal_skeleton",
      private_metadata: "C-allowed-1",
      state: {
        values: {
          team_block: {
            team_select: {
              selected_option: { value: "200", text: { text: "auto-team" } },
            },
          },
          duration_block: {
            duration_select: {
              selected_option: { value: "60", text: { text: "60 minutes" } },
            },
          },
          reason_block: {
            reason_input: {
              value: "Need access for quick bug fix",
            },
          },
        },
      },
    };

    const body = {
      user: {
        team_id: "W123",
        id: "U-req-2",
      },
    };

    const ack = vi.fn();
    const notifier = {
      postManualApproval: vi.fn(),
      updateApprovalMessage: vi.fn(),
      notifyRequester: vi.fn().mockResolvedValue(undefined),
      postAuditLog: vi.fn().mockResolvedValue(undefined),
    };

    const githubClient = {
      getOrganizationMembership: vi.fn().mockResolvedValue({
        state: "active",
        role: "member",
      }),
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (teamId === 300 && userId === 102) {
          return { teamId: 300, githubUserId: 102, role: "member" };
        }
        if (teamId === 200 && userId === 999) {
          return { teamId: 200, githubUserId: 999, role: "maintainer" };
        }
        if (teamId === 200 && userId === 102) {
          return { teamId: 200, githubUserId: 102, role: "member" };
        }
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
      addTeamMember: vi.fn().mockResolvedValue(true),
    };

    await handleRequestModalSubmission({
      view,
      body,
      ack,
      db,
      notifier: notifier as any,
      githubClient: githubClient as any,
    });

    const worker = new JobWorker(db, githubClient, notifier as any);
    await (worker as any).runCycle();
    await (worker as any).runCycle();

    expect(ack).toHaveBeenCalled();

    const grants = db.prepare("SELECT * FROM grants").all() as any[];
    expect(grants).toHaveLength(1);
    expect(grants[0].status).toBe("already_present");
    expect(grants[0].membership_created_by_app).toBe(0);

    expect(githubClient.addTeamMember).not.toHaveBeenCalled();
  });

  it("should fallback to manual approval when request duration exceeds policy limits", async () => {
    const timestamp = new Date().toISOString();

    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "id-req-3",
      "W123",
      "U-req-3",
      103,
      "req-git-3",
      timestamp,
    );

    const teamRepo = new TeamRepository(db);
    teamRepo.upsertTeams(
      1111,
      [
        {
          id: 200,
          name: "auto-team",
          slug: "auto-team",
          description: "",
          privacy: "closed",
        },
      ],
      timestamp,
    );

    identityRepo.createLink(
      "id-creator",
      "W123",
      "U-creator",
      999,
      "creator-git",
      timestamp,
    );

    createTestPolicy(db, {
      id: "pol-auto-1",
      version: 1,
      target_team_id: 200,
      max_duration_minutes: 60,
      snapshot_json: JSON.stringify({
        effect: "auto_approve",
        requester_team_ids: [300],
        max_duration_minutes: 60,
        reason_required: true,
      }),
      slack_workspace_id: "W123",
      github_org_id: 1111,
      created_by_identity_id: "id-creator",
    });

    const view = {
      callback_id: "request_modal_skeleton",
      private_metadata: "C-allowed-1",
      state: {
        values: {
          team_block: {
            team_select: {
              selected_option: { value: "200", text: { text: "auto-team" } },
            },
          },
          duration_block: {
            duration_select: {
              selected_option: { value: "120", text: { text: "120 minutes" } },
            },
          },
          reason_block: {
            reason_input: {
              value: "Need access for quick bug fix",
            },
          },
        },
      },
    };

    const body = {
      user: {
        team_id: "W123",
        id: "U-req-3",
      },
    };

    const ack = vi.fn();
    const notifier = {
      postManualApproval: vi.fn().mockResolvedValue({
        channelId: "C-approval-channel",
        messageTs: "ts-123.456",
      }),
      updateApprovalMessage: vi.fn(),
      notifyRequester: vi.fn(),
      postAuditLog: vi.fn(),
    };

    const githubClient = {
      getOrganizationMembership: vi.fn().mockResolvedValue({
        state: "active",
        role: "member",
      }),
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (teamId === 300 && userId === 103) {
          return { teamId: 300, githubUserId: 103, role: "member" };
        }
        if (teamId === 200 && userId === 999) {
          return { teamId: 200, githubUserId: 999, role: "maintainer" };
        }
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
      addTeamMember: vi.fn(),
    };

    await handleRequestModalSubmission({
      view,
      body,
      ack,
      db,
      notifier: notifier as any,
      githubClient: githubClient as any,
    });

    expect(ack).toHaveBeenCalled();

    const requests = db.prepare("SELECT * FROM access_requests").all() as any[];
    expect(requests).toHaveLength(1);
    expect(requests[0].decision_status).toBe("pending");
    expect(requests[0].decision_mode).toBeNull();

    expect(notifier.postManualApproval).toHaveBeenCalled();
    expect(githubClient.addTeamMember).not.toHaveBeenCalled();

    const events = db
      .prepare("SELECT * FROM audit_events WHERE event_type = ?")
      .all("policy.evaluated") as any[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0].payload_json);
    expect(payload.is_auto_approved).toBe(false);
  });
});
