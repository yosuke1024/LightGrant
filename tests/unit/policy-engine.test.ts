import { describe, it, expect, vi } from "vitest";
import { PolicyEvaluator } from "../../src/services/policy-evaluator.js";
import {
  PolicyRepository,
  DbPolicyWithVersion,
} from "../../src/persistence/repositories/policy-repository.js";

describe("PolicyEvaluator", () => {
  const dummyPolicy: DbPolicyWithVersion = {
    id: "pol-1",
    version: 1,
    target_team_id: 101,
    max_duration_minutes: 120,
    snapshot_json: JSON.stringify({
      effect: "auto_approve",
      requester_team_ids: [300, 301],
      max_duration_minutes: 120,
      reason_required: true,
    }),
    snapshot_hash: "mock-hash-1",
    status: "active",
    owner_identity_id: "owner-id",
    owner_github_user_id: 999,
    created_at: new Date().toISOString(),
  };

  it("should match and auto-approve when all criteria are satisfied", async () => {
    const policyRepo = {
      listActivePoliciesForTeam: vi.fn().mockReturnValue([dummyPolicy]),
    } as any;

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        // Owner is maintainer
        if (teamId === 101 && userId === 999) return { role: "maintainer" };
        // Requester is member of team 300
        if (teamId === 300 && userId === 101) return { role: "member" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
    } as any;

    const evaluator = new PolicyEvaluator(policyRepo, githubClient);
    const result = await evaluator.evaluate({
      requesterGithubUserId: 101,
      targetTeamId: 101,
      durationMinutes: 60,
      reason: "Need bug fix access",
    });

    expect(result.matched).toBe(true);
    expect(result.selectedPolicyId).toBe("pol-1");
    expect(result.selectedPolicyVersion).toBe(1);
    expect(result.selectedPolicySnapshotHash).toBe("mock-hash-1");
    expect(result.matchedRequesterTeamIds).toContain(300);
  });

  it("should fail auto-approve if policy owner is no longer team maintainer", async () => {
    const policyRepo = {
      listActivePoliciesForTeam: vi.fn().mockReturnValue([dummyPolicy]),
    } as any;

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        // Owner is NOT maintainer anymore
        if (teamId === 101 && userId === 999) return { role: "member" };
        if (teamId === 300 && userId === 101) return { role: "member" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
    } as any;

    const evaluator = new PolicyEvaluator(policyRepo, githubClient);
    const result = await evaluator.evaluate({
      requesterGithubUserId: 101,
      targetTeamId: 101,
      durationMinutes: 60,
      reason: "Need bug fix access",
    });

    expect(result.matched).toBe(false);
    expect(result.selectedPolicyId).toBeNull();
  });

  it("should fail auto-approve if requester is not in any eligible requester teams", async () => {
    const policyRepo = {
      listActivePoliciesForTeam: vi.fn().mockReturnValue([dummyPolicy]),
    } as any;

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (teamId === 101 && userId === 999) return { role: "maintainer" };
        // Requester is not in 300 or 301 (throws NotFound)
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
    } as any;

    const evaluator = new PolicyEvaluator(policyRepo, githubClient);
    const result = await evaluator.evaluate({
      requesterGithubUserId: 101,
      targetTeamId: 101,
      durationMinutes: 60,
      reason: "Need bug fix access",
    });

    expect(result.matched).toBe(false);
  });

  it("should fail auto-approve if duration exceeds policy limit", async () => {
    const policyRepo = {
      listActivePoliciesForTeam: vi.fn().mockReturnValue([dummyPolicy]),
    } as any;

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (teamId === 101 && userId === 999) return { role: "maintainer" };
        if (teamId === 300 && userId === 101) return { role: "member" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
    } as any;

    const evaluator = new PolicyEvaluator(policyRepo, githubClient);
    const result = await evaluator.evaluate({
      requesterGithubUserId: 101,
      targetTeamId: 101,
      durationMinutes: 180, // Exceeds 120
      reason: "Need bug fix access",
    });

    expect(result.matched).toBe(false);
  });

  it("should fail auto-approve if reason is missing and policy requires it", async () => {
    const policyRepo = {
      listActivePoliciesForTeam: vi.fn().mockReturnValue([dummyPolicy]),
    } as any;

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (teamId === 101 && userId === 999) return { role: "maintainer" };
        if (teamId === 300 && userId === 101) return { role: "member" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
    } as any;

    const evaluator = new PolicyEvaluator(policyRepo, githubClient);
    const result = await evaluator.evaluate({
      requesterGithubUserId: 101,
      targetTeamId: 101,
      durationMinutes: 60,
      reason: "", // Empty reason
    });

    expect(result.matched).toBe(false);
  });

  it("should sort multiple matched policies deterministically (prefer lower duration, then oldest created_at)", async () => {
    const now = new Date();
    const policyLonger: DbPolicyWithVersion = {
      ...dummyPolicy,
      id: "pol-longer",
      max_duration_minutes: 240,
      snapshot_json: JSON.stringify({
        effect: "auto_approve",
        requester_team_ids: [300],
        max_duration_minutes: 240,
        reason_required: false,
      }),
      created_at: new Date(now.getTime() - 10000).toISOString(), // older
    };
    const policyShorterNewer: DbPolicyWithVersion = {
      ...dummyPolicy,
      id: "pol-shorter",
      max_duration_minutes: 60,
      snapshot_json: JSON.stringify({
        effect: "auto_approve",
        requester_team_ids: [300],
        max_duration_minutes: 60,
        reason_required: false,
      }),
      created_at: now.toISOString(), // newer
    };

    const policyRepo = {
      listActivePoliciesForTeam: vi
        .fn()
        .mockReturnValue([policyLonger, policyShorterNewer]),
    } as any;

    const githubClient = {
      getTeamMembership: vi.fn().mockImplementation(async (teamId, userId) => {
        if (teamId === 101 && userId === 999) return { role: "maintainer" };
        if (teamId === 300 && userId === 101) return { role: "member" };
        const err = new Error("Not Found");
        err.name = "GitHubNotFoundError";
        throw err;
      }),
    } as any;

    const evaluator = new PolicyEvaluator(policyRepo, githubClient);
    const result = await evaluator.evaluate({
      requesterGithubUserId: 101,
      targetTeamId: 101,
      durationMinutes: 30,
      reason: "foo",
    });

    expect(result.matched).toBe(true);
    // Should prefer pol-shorter despite being newer because max_duration is smaller (60 < 240)
    expect(result.selectedPolicyId).toBe("pol-shorter");
  });
});
