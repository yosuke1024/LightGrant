import Database from "better-sqlite3";
import crypto from "crypto";

export interface DbPolicy {
  id: string; // policies.id
  version: number; // policy_versions.version
  target_team_id: number; // policies.target_team_id
  max_duration_minutes: number; // policy_versions.max_duration_minutes
  snapshot_json: string; // policy_versions.snapshot_json
  status: string; // policies.status
}

export interface DbPolicyWithVersion {
  id: string;
  version: number;
  target_team_id: number;
  max_duration_minutes: number;
  snapshot_json: string;
  snapshot_hash: string;
  status: string;
  owner_identity_id: string;
  owner_github_user_id: number;
  created_at: string;
}

interface DbPolicyRow {
  id: string;
  version: number;
  target_team_id: number;
  max_duration_minutes: number;
  snapshot_json: string;
  snapshot_hash: string;
  status: string;
  owner_identity_id: string;
  owner_github_user_id: number;
  created_at: string;
}

export class PolicyRepository {
  constructor(private db: Database.Database) {}

  /**
   * Retrieve active policies with their latest active version details for a given GitHub Team ID.
   * Joins with identity_links to retrieve the owner's github_user_id.
   */
  listActivePoliciesForTeam(teamId: number): DbPolicyWithVersion[] {
    const rows = this.db
      .prepare(
        `
      SELECT 
        p.id,
        pv.version,
        p.target_team_id,
        pv.max_duration_minutes,
        pv.snapshot_json,
        pv.snapshot_hash,
        p.status,
        p.created_by_identity_id AS owner_identity_id,
        il.github_user_id AS owner_github_user_id,
        pv.created_at
      FROM policies p
      JOIN policy_versions pv ON p.id = pv.policy_id AND p.current_version = pv.version
      JOIN identity_links il ON p.created_by_identity_id = il.id
      WHERE p.target_team_id = ? AND p.status = 'active' AND p.disabled_at IS NULL
    `,
      )
      .all(teamId);
    return (rows as DbPolicyRow[]).map((row) => ({
      id: row.id,
      version: row.version,
      target_team_id: row.target_team_id,
      max_duration_minutes: row.max_duration_minutes,
      snapshot_json: row.snapshot_json,
      snapshot_hash: row.snapshot_hash,
      status: row.status,
      owner_identity_id: row.owner_identity_id,
      owner_github_user_id: row.owner_github_user_id,
      created_at: row.created_at,
    }));
  }



  /**
   * Retrieve all active policies across the workspace.
   * Useful for periodic authority checks on policy owners.
   */
  listAllActivePolicies(): DbPolicyWithVersion[] {
    const rows = this.db
      .prepare(
        `
      SELECT 
        p.id,
        pv.version,
        p.target_team_id,
        pv.max_duration_minutes,
        pv.snapshot_json,
        pv.snapshot_hash,
        p.status,
        p.created_by_identity_id AS owner_identity_id,
        il.github_user_id AS owner_github_user_id,
        pv.created_at
      FROM policies p
      JOIN policy_versions pv ON p.id = pv.policy_id AND p.current_version = pv.version
      JOIN identity_links il ON p.created_by_identity_id = il.id
      WHERE p.status = 'active' AND p.disabled_at IS NULL
    `,
      )
      .all();
    return (rows as DbPolicyRow[]).map((row) => ({
      id: row.id,
      version: row.version,
      target_team_id: row.target_team_id,
      max_duration_minutes: row.max_duration_minutes,
      snapshot_json: row.snapshot_json,
      snapshot_hash: row.snapshot_hash,
      status: row.status,
      owner_identity_id: row.owner_identity_id,
      owner_github_user_id: row.owner_github_user_id,
      created_at: row.created_at,
    }));
  }

  /**
   * Get the active policy with its latest version details for a specific team.
   */
  getPolicyForTeam(teamId: number): DbPolicyWithVersion | null {
    const row = this.db
      .prepare(
        `
      SELECT 
        p.id,
        pv.version,
        p.target_team_id,
        pv.max_duration_minutes,
        pv.snapshot_json,
        pv.snapshot_hash,
        p.status,
        p.created_by_identity_id AS owner_identity_id,
        il.github_user_id AS owner_github_user_id,
        pv.created_at
      FROM policies p
      JOIN policy_versions pv ON p.id = pv.policy_id AND p.current_version = pv.version
      JOIN identity_links il ON p.created_by_identity_id = il.id
      WHERE p.target_team_id = ? AND p.status = 'active' AND p.disabled_at IS NULL
      LIMIT 1
    `,
      )
      .get(teamId) as DbPolicyRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      target_team_id: row.target_team_id,
      max_duration_minutes: row.max_duration_minutes,
      snapshot_json: row.snapshot_json,
      snapshot_hash: row.snapshot_hash,
      status: row.status,
      owner_identity_id: row.owner_identity_id,
      owner_github_user_id: row.owner_github_user_id,
      created_at: row.created_at,
    };
  }

  /**
   * Disable a policy with a status update.
   */
  disablePolicy(policyId: string, reason: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE policies
      SET status = 'disabled', disabled_at = ?, disabled_reason = ?, updated_at = ?
      WHERE id = ?
    `,
      )
      .run(now, reason, now, policyId);
  }

  /**
   * Update or create a policy version within a transaction.
   * Increments current_version on policies table and appends to policy_versions.
   */
  createPolicyVersionTx(params: {
    policyId: string;
    version: number;
    maxDurationMinutes: number;
    snapshotJson: string;
    snapshotHash: string;
    createdByIdentityId: string;
    requesterTeamIdsJson: string;
    reasonRequired: number;
    slackWorkspaceId: string;
    githubOrgId: number;
    targetTeamId: number;
    isNewPolicy: boolean;
  }): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (params.isNewPolicy) {
        // Create new policy record
        this.db
          .prepare(
            `
          INSERT INTO policies (
            id, slack_workspace_id, github_org_id, target_team_id, status, current_version, created_by_identity_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
        `,
          )
          .run(
            params.policyId,
            params.slackWorkspaceId,
            params.githubOrgId,
            params.targetTeamId,
            params.version,
            params.createdByIdentityId,
            now,
            now,
          );
      } else {
        // Update current version and ensure status is active
        this.db
          .prepare(
            `
          UPDATE policies
          SET current_version = ?, status = 'active', disabled_at = NULL, disabled_reason = NULL, updated_at = ?
          WHERE id = ?
        `,
          )
          .run(params.version, now, params.policyId);
      }

      // Add immutable version entry
      this.db
        .prepare(
          `
        INSERT INTO policy_versions (
          id, policy_id, version, effect, requester_team_ids_json, max_duration_minutes, reason_required, snapshot_json, snapshot_hash, created_by_identity_id, authority_verified_at, created_at
        ) VALUES (?, ?, ?, 'auto_approve', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          crypto.randomUUID(),
          params.policyId,
          params.version,
          params.requesterTeamIdsJson,
          params.maxDurationMinutes,
          params.reasonRequired,
          params.snapshotJson,
          params.snapshotHash,
          params.createdByIdentityId,
          now,
          now,
        );
    })();
  }
}
