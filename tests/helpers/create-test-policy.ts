import Database from "better-sqlite3";
import crypto from "crypto";

/**
 * Seed helper for test policies. This isolates test seed logic from production repository class.
 */
export function createTestPolicy(
  db: Database.Database,
  policy: {
    id: string;
    version: number;
    target_team_id: number;
    max_duration_minutes: number;
    snapshot_json: string;
    slack_workspace_id: string;
    github_org_id: number;
    created_by_identity_id: string;
  }
): void {
  const now = new Date().toISOString();

  // 1. Insert into policies table
  db.prepare(
    `
    INSERT INTO policies (
      id, slack_workspace_id, github_org_id, target_team_id, status, current_version, created_by_identity_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)
    `
  ).run(
    policy.id,
    policy.slack_workspace_id,
    policy.github_org_id,
    policy.target_team_id,
    policy.version,
    policy.created_by_identity_id,
    now,
    now,
  );

  // 2. Insert into policy_versions table
  db.prepare(
    `
    INSERT INTO policy_versions (
      id, policy_id, version, effect, requester_team_ids_json, max_duration_minutes, reason_required, snapshot_json, snapshot_hash, created_by_identity_id, authority_verified_at, created_at
    ) VALUES (?, ?, ?, 'allow', '[]', ?, 1, ?, 'dummy-hash', ?, ?, ?)
    `
  ).run(
    crypto.randomUUID(),
    policy.id,
    policy.version,
    policy.max_duration_minutes,
    policy.snapshot_json,
    policy.created_by_identity_id,
    now,
    now,
  );
}
