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
import { JobWorker } from "../../src/workers/job-worker.js";
import { PolicyService } from "../../src/services/policy-service.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { PolicyRepository } from "../../src/persistence/repositories/policy-repository.js";
import { JobRepository } from "../../src/persistence/repositories/job-repository.js";
import { SlackNotifier } from "../../src/services/slack-notifier.js";

describe("Policy Validator (validate_policy_authority Job)", () => {
  const tempDbPath = path.resolve("./tests/policy-validator-test.sqlite");
  let db: Database.Database;
  let policyRepo: PolicyRepository;
  let identityRepo: IdentityRepository;
  let jobRepo: JobRepository;

  const mockGithubClient = {
    getTeamMembership: vi.fn(),
    getOrganizationMembership: vi.fn(),
  };

  const mockNotifier = {
    postPolicyDisabledAlert: vi.fn().mockResolvedValue(undefined),
  } as unknown as SlackNotifier;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    policyRepo = new PolicyRepository(db);
    identityRepo = new IdentityRepository(db);
    jobRepo = new JobRepository(db);
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
    vi.clearAllMocks();
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM policies").run();
    db.prepare("DELETE FROM policy_versions").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("DELETE FROM jobs").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should keep policy active if owner is still a Maintainer of the target team", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    const policyService = new PolicyService(db);
    const { policyId } = policyService.upsertPolicy({
      targetTeamId: 100,
      maxDurationMinutes: 120,
      requesterTeamIds: [200],
      reasonRequired: true,
      slackWorkspaceId: "W123",
      githubOrgId: 1,
      createdByIdentityId: "identity-1",
    });

    // Submitter is still a maintainer
    mockGithubClient.getTeamMembership.mockResolvedValue({
      role: "maintainer",
    });

    // Enqueue verification job
    jobRepo.enqueuePolicyValidationJob();

    const worker = new JobWorker(db, mockGithubClient, mockNotifier);
    await worker["runCycle"](); // Call internal cycle runner

    // Check policy is still active
    const policy = policyRepo.getPolicyForTeam(100);
    expect(policy).not.toBeNull();
    expect(policy!.status).toBe("active");
    expect(mockNotifier.postPolicyDisabledAlert).not.toHaveBeenCalled();
  });

  it("should disable policy and send alert if owner is no longer a Maintainer of the target team", async () => {
    const timestamp = new Date().toISOString();
    identityRepo.createLink(
      "identity-1",
      "W123",
      "U456",
      999,
      "octocat",
      timestamp,
    );

    const policyService = new PolicyService(db);
    const { policyId } = policyService.upsertPolicy({
      targetTeamId: 100,
      maxDurationMinutes: 120,
      requesterTeamIds: [200],
      reasonRequired: true,
      slackWorkspaceId: "W123",
      githubOrgId: 1,
      createdByIdentityId: "identity-1",
    });

    // Owner is demoted to normal member or not in team anymore
    mockGithubClient.getTeamMembership.mockResolvedValue({ role: "member" });

    jobRepo.enqueuePolicyValidationJob();

    const worker = new JobWorker(db, mockGithubClient, mockNotifier);
    await worker["runCycle"]();

    // Check policy is disabled
    const policy = policyRepo.getPolicyForTeam(100);
    expect(policy).toBeNull(); // getPolicyForTeam only returns active policies

    const rawPolicy = db
      .prepare("SELECT * FROM policies WHERE id = ?")
      .get(policyId) as any;
    expect(rawPolicy.status).toBe("disabled");
    expect(rawPolicy.disabled_reason).toBe("owner_no_longer_maintainer");
    expect(mockNotifier.postPolicyDisabledAlert).toHaveBeenCalled();
  });
});
