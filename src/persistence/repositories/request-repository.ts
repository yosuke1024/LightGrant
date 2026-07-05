import Database from "better-sqlite3";

export interface DbAccessRequest {
  id: string;
  slack_workspace_id: string;
  github_org_id: number;
  requester_identity_id: string;
  target_team_id: number;
  duration_minutes: number;
  reason: string;
  decision_status: string; // 'pending' | 'approved' | 'denied'
  decision_mode: string | null; // 'manual' | 'auto'
  matched_policy_id: string | null;
  matched_policy_version: number | null;
  requested_at: string;
  decided_at: string | null;
  denied_reason: string | null;
  slack_approval_channel_id: string | null;
  slack_approval_message_ts: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRequestInput {
  id: string;
  slackWorkspaceId: string;
  githubOrgId: number;
  requesterIdentityId: string;
  targetTeamId: number;
  durationMinutes: number;
  reason: string;
  decisionStatus: string;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Handles operations on the `access_requests` table in SQLite.
 */
export class RequestRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert a new access request into the database.
   */
  createRequest(input: CreateRequestInput): void {
    this.db
      .prepare(
        `
      INSERT INTO access_requests (
        id,
        slack_workspace_id,
        github_org_id,
        requester_identity_id,
        target_team_id,
        duration_minutes,
        reason,
        decision_status,
        requested_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        input.id,
        input.slackWorkspaceId,
        input.githubOrgId,
        input.requesterIdentityId,
        input.targetTeamId,
        input.durationMinutes,
        input.reason,
        input.decisionStatus,
        input.requestedAt,
        input.createdAt,
        input.updatedAt,
      );
  }

  /**
   * Get an access request by ID.
   */
  getRequest(id: string): DbAccessRequest | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM access_requests WHERE id = ?
    `,
      )
      .get(id);
    return (row as DbAccessRequest) || null;
  }

  /**
   * Update the decision status and details of the access request using compare-and-set.
   * Returns the number of changes made (1 if successful, 0 if already decided).
   */
  updateDecisionStatus(
    id: string,
    status: string,
    mode: string | null,
    decidedAt: string | null,
    deniedReason: string | null,
  ): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
      UPDATE access_requests
      SET 
        decision_status = ?,
        decision_mode = ?,
        decided_at = ?,
        denied_reason = ?,
        updated_at = ?
      WHERE id = ? AND decision_status = 'pending'
    `,
      )
      .run(status, mode, decidedAt, deniedReason, now, id);
    return result.changes;
  }

  /**
   * Update the Slack channel and timestamp info for the posted approval message.
   */
  updateSlackMessageInfo(
    id: string,
    channelId: string,
    messageTs: string,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE access_requests
      SET
        slack_approval_channel_id = ?,
        slack_approval_message_ts = ?,
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(channelId, messageTs, now, id);
  }

  /**
   * Update the matched policy details on the access request.
   */
  updatePolicyInfo(id: string, policyId: string, policyVersion: number): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE access_requests
      SET
        matched_policy_id = ?,
        matched_policy_version = ?,
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(policyId, policyVersion, now, id);
  }
}
