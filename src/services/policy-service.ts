import Database from "better-sqlite3";
import crypto from "crypto";
import { PolicyRepository } from "../persistence/repositories/policy-repository.js";
import { canonicalJson, sha256 } from "../security/hashing.js";

export interface AutoApprovalPolicySnapshot {
  effect: "auto_approve";
  requester_team_ids: number[];
  max_duration_minutes: number;
  reason_required: boolean;
}

export function generateSnapshotHash(
  snapshot: AutoApprovalPolicySnapshot,
): string {
  return sha256(canonicalJson(snapshot));
}

export class PolicyService {
  private policyRepo: PolicyRepository;

  constructor(private db: Database.Database) {
    this.policyRepo = new PolicyRepository(db);
  }

  /**
   * Upsert a policy (creates a new policy or appends a new immutable version)
   */
  upsertPolicy(params: {
    targetTeamId: number;
    maxDurationMinutes: number;
    requesterTeamIds: number[];
    reasonRequired: boolean;
    slackWorkspaceId: string;
    githubOrgId: number;
    createdByIdentityId: string;
  }): { policyId: string; version: number; snapshotHash: string } {
    const existingPolicy = this.policyRepo.getPolicyForTeam(
      params.targetTeamId,
    );

    const isNewPolicy = !existingPolicy;
    const policyId = existingPolicy ? existingPolicy.id : crypto.randomUUID();
    const version = existingPolicy ? existingPolicy.version + 1 : 1;

    const snapshot: AutoApprovalPolicySnapshot = {
      effect: "auto_approve",
      requester_team_ids: [...params.requesterTeamIds].sort((a, b) => a - b),
      max_duration_minutes: params.maxDurationMinutes,
      reason_required: params.reasonRequired,
    };

    const snapshotJson = JSON.stringify(snapshot);
    const snapshotHash = generateSnapshotHash(snapshot);
    const requesterTeamIdsJson = JSON.stringify(params.requesterTeamIds);

    this.policyRepo.createPolicyVersionTx({
      policyId,
      version,
      maxDurationMinutes: params.maxDurationMinutes,
      snapshotJson,
      snapshotHash,
      createdByIdentityId: params.createdByIdentityId,
      requesterTeamIdsJson,
      reasonRequired: params.reasonRequired ? 1 : 0,
      slackWorkspaceId: params.slackWorkspaceId,
      githubOrgId: params.githubOrgId,
      targetTeamId: params.targetTeamId,
      isNewPolicy,
    });

    return { policyId, version, snapshotHash };
  }
}
