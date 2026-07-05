import { GitHubAccessProvider } from "../integrations/github/github-client.js";
import {
  PolicyRepository,
  DbPolicyWithVersion,
} from "../persistence/repositories/policy-repository.js";
import { AutoApprovalPolicySnapshot } from "../domain/policy-engine.js";
import { logger } from "../logger.js";

export interface PolicyEvaluationInput {
  requesterGithubUserId: number;
  targetTeamId: number;
  durationMinutes: number;
  reason: string;
}

export interface EvaluatedPolicyResult {
  policyId: string;
  version: number;
  matched: boolean;
  reasonForOutcome: string;
}

export interface PolicyEvaluationResult {
  matched: boolean;
  selectedPolicyId: string | null;
  selectedPolicyVersion: number | null;
  selectedPolicySnapshotHash: string | null;
  matchedRequesterTeamIds: number[];
  evaluatedPolicies: EvaluatedPolicyResult[];
}

export class PolicyEvaluator {
  constructor(
    private policyRepo: PolicyRepository,
    private githubClient: GitHubAccessProvider,
  ) {}

  /**
   * Evaluates if a request can be auto-approved based on GitHub Team-based policies.
   */
  async evaluate(
    input: PolicyEvaluationInput,
  ): Promise<PolicyEvaluationResult> {
    const { requesterGithubUserId, targetTeamId, durationMinutes, reason } =
      input;

    // 1. Get active policies for target team
    const activePolicies =
      this.policyRepo.listActivePoliciesForTeam(targetTeamId);

    const evaluatedPolicies: EvaluatedPolicyResult[] = [];
    const matchedPolicies: {
      policy: DbPolicyWithVersion;
      matchedRequesterTeamIds: number[];
    }[] = [];

    for (const policy of activePolicies) {
      let matched = false;
      let outcomeReason = "";
      const matchedRequesterTeamIds: number[] = [];

      try {
        // A. Verify policy owner is still a maintainer of target team
        let ownerRole: string | null = null;
        try {
          const ownerMembership = await this.githubClient.getTeamMembership(
            targetTeamId,
            policy.owner_github_user_id,
          );
          ownerRole = ownerMembership ? ownerMembership.role : null;
        } catch (err) {
          if ((err as Error).name !== "GitHubNotFoundError") {
            throw err;
          }
        }

        if (ownerRole !== "maintainer") {
          outcomeReason = `Policy owner is no longer a maintainer of the target team (current role: ${ownerRole || "none"}).`;
        } else {
          // B. Parse policy snapshot
          const snapshot: AutoApprovalPolicySnapshot = JSON.parse(
            policy.snapshot_json,
          );

          // C. Verify requester is active member/maintainer of eligible requester teams
          let isMemberOfEligibleTeam = false;
          for (const teamId of snapshot.requester_team_ids) {
            try {
              const membership = await this.githubClient.getTeamMembership(
                teamId,
                requesterGithubUserId,
              );
              if (membership) {
                isMemberOfEligibleTeam = true;
                matchedRequesterTeamIds.push(teamId);
              }
            } catch (err) {
              if ((err as Error).name !== "GitHubNotFoundError") {
                throw err;
              }
            }
          }

          if (!isMemberOfEligibleTeam) {
            outcomeReason =
              "Requester is not a member of any eligible requester teams defined in the policy.";
          } else if (durationMinutes > snapshot.max_duration_minutes) {
            outcomeReason = `Requested duration (${durationMinutes} mins) exceeds maximum allowed duration (${snapshot.max_duration_minutes} mins).`;
          } else if (
            snapshot.reason_required &&
            (!reason || reason.trim() === "")
          ) {
            outcomeReason = "Reason is required but was not provided.";
          } else {
            matched = true;
            outcomeReason = "All policy rules satisfied.";
          }
        }
      } catch (err) {
        logger.error(
          { err, policyId: policy.id },
          "Error evaluating policy rules",
        );
        outcomeReason = `Error during policy evaluation: ${err instanceof Error ? err.message : String(err)}`;
      }

      evaluatedPolicies.push({
        policyId: policy.id,
        version: policy.version,
        matched,
        reasonForOutcome: outcomeReason,
      });

      if (matched) {
        matchedPolicies.push({ policy, matchedRequesterTeamIds });
      }
    }

    if (matchedPolicies.length === 0) {
      return {
        matched: false,
        selectedPolicyId: null,
        selectedPolicyVersion: null,
        selectedPolicySnapshotHash: null,
        matchedRequesterTeamIds: [],
        evaluatedPolicies,
      };
    }

    // Sort matching policies deterministically:
    // 1. Min max_duration_minutes
    // 2. Oldest created_at
    // 3. Ascending policy ID
    matchedPolicies.sort((a, b) => {
      if (a.policy.max_duration_minutes !== b.policy.max_duration_minutes) {
        return a.policy.max_duration_minutes - b.policy.max_duration_minutes;
      }
      const timeA = new Date(a.policy.created_at).getTime();
      const timeB = new Date(b.policy.created_at).getTime();
      if (timeA !== timeB) {
        return timeA - timeB;
      }
      return a.policy.id.localeCompare(b.policy.id);
    });

    const bestMatch = matchedPolicies[0];

    return {
      matched: true,
      selectedPolicyId: bestMatch.policy.id,
      selectedPolicyVersion: bestMatch.policy.version,
      selectedPolicySnapshotHash: bestMatch.policy.snapshot_hash,
      matchedRequesterTeamIds: bestMatch.matchedRequesterTeamIds,
      evaluatedPolicies,
    };
  }
}
