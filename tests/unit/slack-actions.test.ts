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
  handleApproveAction,
  handleDenyAction,
  handleDenyModalSubmission,
} from "../../src/integrations/slack/actions.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { RequestRepository } from "../../src/persistence/repositories/request-repository.js";
import { ApprovalRepository } from "../../src/persistence/repositories/approval-repository.js";
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import { JobWorker } from "../../src/workers/job-worker.js";
import fs from "fs";
import path from "path";

describe("Slack Approve and Deny Actions", () => {
  const tempDbPath = path.resolve("./tests/slack-actions-test.sqlite");
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
    db.prepare("DELETE FROM grants").run();
    db.prepare("DELETE FROM access_requests").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("Approve Action: should fail if approver is not linked", async () => {
    const timestamp = new Date().toISOString();
    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "identity-req-1",
      "W123",
      "U-req",
      101,
      "req-git",
      timestamp,
    );

    const requestRepo = new RequestRepository(db);
    requestRepo.createRequest({
      id: "req-1",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-req-1",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "Testing unlinked approver",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const respond = vi.fn();
    const action = { value: "req-1" };
    const body = { user: { id: "U-approver", team_id: "W123" } };

    await handleApproveAction({
      action,
      body,
      respond,
      db,
      githubClient: {} as any,
      notifier: {} as any,
    });

    expect(respond).toHaveBeenCalled();
    const respondArg = respond.mock.calls[0][0];
    expect(respondArg.text).toContain("GitHub account connection is required");
  });

  it("Approve Action: should fail if approver does not have permissions", async () => {
    const timestamp = new Date().toISOString();
    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "id-req",
      "W123",
      "U-req",
      101,
      "req-git",
      timestamp,
    );
    identityRepo.createLink(
      "id-appr",
      "W123",
      "U-appr",
      202,
      "appr-git",
      timestamp,
    );

    const requestRepo = new RequestRepository(db);
    requestRepo.createRequest({
      id: "req-2",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "id-req",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "Testing unauthorized approver",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const respond = vi.fn();
    const action = { value: "req-2" };
    const body = { user: { id: "U-appr", team_id: "W123" } };

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async () => {
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
      getOrganizationMembership: vi.fn().mockImplementation(async () => {
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
    };

    await handleApproveAction({
      action,
      body,
      respond,
      db,
      githubClient: githubClient as any,
      notifier: {} as any,
    });

    expect(respond).toHaveBeenCalled();
    const respondArg = respond.mock.calls[0][0];
    expect(respondArg.text).toContain("do not have permission");

    const req = requestRepo.getRequest("req-2");
    expect(req?.decision_status).toBe("pending");
  });

  it("Approve Action: should succeed and create grant if approver is team maintainer", async () => {
    const timestamp = new Date().toISOString();
    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "id-req",
      "W123",
      "U-req",
      101,
      "req-git",
      timestamp,
    );
    identityRepo.createLink(
      "id-appr",
      "W123",
      "U-appr",
      202,
      "appr-git",
      timestamp,
    );

    const requestRepo = new RequestRepository(db);
    requestRepo.createRequest({
      id: "req-3",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "id-req",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "Testing authorization success",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    requestRepo.updateSlackMessageInfo("req-3", "C-appr-channel", "msg-ts-123");

    const respond = vi.fn();
    const action = { value: "req-3" };
    const body = { user: { id: "U-appr", team_id: "W123" } };

    let memberChecked = false;
    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (userId === 202) return { role: "maintainer" };
        if (userId === 101) {
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
      getOrganizationMembership: vi.fn().mockImplementation(async (userId) => {
        if (userId === 101) return { state: "active", role: "member" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
      addTeamMember: vi.fn().mockResolvedValue(true),
    };

    const notifier = {
      postManualApproval: vi.fn(),
      updateApprovalMessage: vi.fn().mockResolvedValue(undefined),
      notifyRequester: vi.fn().mockResolvedValue(undefined),
      postAuditLog: vi.fn().mockResolvedValue(undefined),
    };

    await handleApproveAction({
      action,
      body,
      respond,
      db,
      githubClient: githubClient as any,
      notifier,
    });

    const worker = new JobWorker(db, githubClient, notifier as any);
    await (worker as any).runCycle();

    const req = requestRepo.getRequest("req-3");
    expect(req?.decision_status).toBe("approved");
    expect(req?.decision_mode).toBe("manual");

    const approvals = db.prepare("SELECT * FROM approvals").all();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].authority_role).toBe("team_maintainer");

    const grants = db.prepare("SELECT * FROM grants").all();
    expect(grants).toHaveLength(1);
    expect(grants[0].membership_created_by_app).toBe(1);
    expect(grants[0].status).toBe("active");

    expect(notifier.updateApprovalMessage).toHaveBeenCalled();
  });

  it("Approve Action: should protect preexisting membership and mark createdByApp=0", async () => {
    const timestamp = new Date().toISOString();
    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "id-req",
      "W123",
      "U-req",
      101,
      "req-git",
      timestamp,
    );
    identityRepo.createLink(
      "id-appr",
      "W123",
      "U-appr",
      202,
      "appr-git",
      timestamp,
    );

    const requestRepo = new RequestRepository(db);
    requestRepo.createRequest({
      id: "req-4",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "id-req",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "Testing preexisting role",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    requestRepo.updateSlackMessageInfo("req-4", "C-channel", "msg-ts-456");

    const respond = vi.fn();
    const action = { value: "req-4" };
    const body = { user: { id: "U-appr", team_id: "W123" } };

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (userId === 202) return { role: "maintainer" };
        if (userId === 101) return { role: "member" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
      getOrganizationMembership: vi.fn().mockImplementation(async (userId) => {
        if (userId === 101) return { state: "active", role: "member" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
      addTeamMember: vi.fn().mockResolvedValue(true),
    };

    const notifier = {
      postManualApproval: vi.fn(),
      updateApprovalMessage: vi.fn().mockResolvedValue(undefined),
      notifyRequester: vi.fn().mockResolvedValue(undefined),
      postAuditLog: vi.fn().mockResolvedValue(undefined),
    };

    await handleApproveAction({
      action,
      body,
      respond,
      db,
      githubClient: githubClient as any,
      notifier,
    });

    const worker = new JobWorker(db, githubClient, notifier as any);
    await (worker as any).runCycle();

    const grants = db.prepare("SELECT * FROM grants").all();
    expect(grants).toHaveLength(1);
    expect(grants[0].membership_created_by_app).toBe(0);
    expect(grants[0].status).toBe("already_present");
  });

  it("Deny Action: should open deny reason modal", async () => {
    const timestamp = new Date().toISOString();
    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "identity-req-deny",
      "W123",
      "U-req",
      101,
      "req-git",
      timestamp,
    );
    identityRepo.createLink(
      "id-appr",
      "W123",
      "U-appr",
      202,
      "appr-git",
      timestamp,
    );

    const requestRepo = new RequestRepository(db);
    requestRepo.createRequest({
      id: "req-deny-1",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "identity-req-deny",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "To be denied",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const action = { value: "req-deny-1" };
    const body = {
      user: { id: "U-appr", team_id: "W123" },
      trigger_id: "trig-deny",
    };
    const client = {
      views: {
        open: vi.fn().mockResolvedValue({ ok: true }),
      },
      chat: {
        postEphemeral: vi.fn(),
      },
    };

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (userId === 202) return { role: "maintainer" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
      getOrganizationMembership: vi.fn().mockImplementation(async () => {
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
    };

    await handleDenyAction({
      action,
      body: body as any,
      client: client as any,
      db,
      githubClient: githubClient as any,
    });

    expect(client.views.open).toHaveBeenCalled();
    const openArg = client.views.open.mock.calls[0][0];
    expect(openArg.trigger_id).toBe("trig-deny");
    expect(openArg.view.callback_id).toBe("deny_reason_modal");
    expect(openArg.view.private_metadata).toBe("req-deny-1");
  });

  it("Deny Modal Submission: should update request to denied and notify requester", async () => {
    const timestamp = new Date().toISOString();
    const identityRepo = new IdentityRepository(db);
    identityRepo.createLink(
      "id-req",
      "W123",
      "U-req",
      101,
      "req-git",
      timestamp,
    );
    identityRepo.createLink(
      "id-appr",
      "W123",
      "U-appr",
      202,
      "appr-git",
      timestamp,
    );

    const requestRepo = new RequestRepository(db);
    requestRepo.createRequest({
      id: "req-5",
      slackWorkspaceId: "W123",
      githubOrgId: 1111,
      requesterIdentityId: "id-req",
      targetTeamId: 2222,
      durationMinutes: 60,
      reason: "To be denied",
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    requestRepo.updateSlackMessageInfo("req-5", "C-channel", "msg-ts-789");

    const view = {
      callback_id: "deny_reason_modal",
      private_metadata: "req-5",
      state: {
        values: {
          reason_block: {
            reason_input: {
              value: "Not allowed duration",
            },
          },
        },
      },
    };

    const body = {
      user: { id: "U-appr", team_id: "W123" },
    };

    const ack = vi.fn();
    const notifier = {
      postManualApproval: vi.fn(),
      updateApprovalMessage: vi.fn().mockResolvedValue(undefined),
      notifyRequester: vi.fn().mockResolvedValue(undefined),
      postAuditLog: vi.fn().mockResolvedValue(undefined),
    };

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (userId === 202) return { role: "maintainer" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
      getOrganizationMembership: vi.fn().mockImplementation(async () => {
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
    };

    await handleDenyModalSubmission({
      view: view as any,
      body: body as any,
      ack,
      db,
      notifier,
      githubClient: githubClient as any,
    });

    expect(ack).toHaveBeenCalled();

    const req = requestRepo.getRequest("req-5");
    expect(req?.decision_status).toBe("denied");
    expect(req?.denied_reason).toBe("Not allowed duration");

    const approvals = db.prepare("SELECT * FROM approvals").all();
    expect(approvals).toHaveLength(1);
    expect(approvals[0].decision).toBe("denied");
    expect(approvals[0].reason).toBe("Not allowed duration");
  });
});
