import Database from "better-sqlite3";

export interface DbGrant {
  id: string;
  github_org_id: number;
  target_team_id: number;
  github_user_id: number;
  github_login_snapshot: string;
  status: string; // 'active' | 'revoked' | 'already_present' | 'failed'
  membership_created_by_app: number; // BOOLEAN (0 or 1)
  preexisting_role: string | null;
  granted_at: string | null;
  effective_expires_at: string;
  revoked_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  revoke_attempt_count: number;
  next_revoke_attempt_at: string | null;
  last_alerted_at: string | null;
  alert_attempt_count: number;
  created_at: string;
  updated_at: string;
  // New columns for RC hardening
  membership_mutation_state: string;
  membership_add_attempted_at: string | null;
  membership_add_operation_id: string | null;
  membership_add_last_verified_at: string | null;
  last_revoke_alert_at: string | null;
  last_revoke_alert_reason: string | null;
}

export interface CreateGrantInput {
  id: string;
  githubOrgId: number;
  targetTeamId: number;
  githubUserId: number;
  githubLoginSnapshot: string;
  status: string;
  membershipCreatedByApp: number;
  preexistingRole: string | null;
  grantedAt: string | null;
  effectiveExpiresAt: string;
  createdAt: string;
  updatedAt: string;
  membershipMutationState?: string;
  membershipAddAttemptedAt?: string | null;
  membershipAddOperationId?: string | null;
  membershipAddLastVerifiedAt?: string | null;
}

/**
 * Handles operations on the `grants` table in SQLite.
 */
export class GrantRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert a new membership grant.
   */
  createGrant(input: CreateGrantInput): void {
    this.db
      .prepare(
        `
      INSERT INTO grants (
        id,
        github_org_id,
        target_team_id,
        github_user_id,
        github_login_snapshot,
        status,
        membership_created_by_app,
        preexisting_role,
        granted_at,
        effective_expires_at,
        created_at,
        updated_at,
        membership_mutation_state,
        membership_add_attempted_at,
        membership_add_operation_id,
        membership_add_last_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        input.id,
        input.githubOrgId,
        input.targetTeamId,
        input.githubUserId,
        input.githubLoginSnapshot,
        input.status,
        input.membershipCreatedByApp,
        input.preexistingRole,
        input.grantedAt,
        input.effectiveExpiresAt,
        input.createdAt,
        input.updatedAt,
        input.membershipMutationState || "not_started",
        input.membershipAddAttemptedAt || null,
        input.membershipAddOperationId || null,
        input.membershipAddLastVerifiedAt || null,
      );
  }

  /**
   * Retrieve a membership grant by ID.
   */
  getGrant(id: string): DbGrant | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM grants WHERE id = ?
    `,
      )
      .get(id);
    return (row as DbGrant) || null;
  }

  /**
   * Update status of the grant (e.g. mark revoked, failed, active, etc.)
   */
  updateGrantStatus(
    id: string,
    status: string,
    revokedAt: string | null,
    lastErrorCode?: string | null,
    lastErrorMessage?: string | null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE grants
      SET 
        status = ?,
        revoked_at = ?,
        last_error_code = COALESCE(?, last_error_code),
        last_error_message = COALESCE(?, last_error_message),
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        status,
        revokedAt,
        lastErrorCode || null,
        lastErrorMessage || null,
        now,
        id,
      );
  }

  /**
   * Retrieve active or failing grants that have expired.
   */
  getExpiredGrants(nowStr: string): DbGrant[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM grants
      WHERE status IN ('active', 'revoke_failed', 'already_present')
        AND effective_expires_at <= ?
        AND (
          status IN ('active', 'already_present')
          OR next_revoke_attempt_at <= ?
        )
        AND revoked_at IS NULL
    `,
      )
      .all(nowStr, nowStr);
    return (rows as DbGrant[]) || [];
  }

  /**
   * Update revocation details including retry attempts.
   */
  updateRevocationStatus(
    id: string,
    params: {
      status: string;
      revokedAt: string | null;
      attemptCount: number;
      nextAttemptAt: string | null;
      errorCode: string | null;
      errorMessage: string | null;
      lastAlertedAt?: string | null;
      alertAttemptCount?: number;
      lastRevokeAlertAt?: string | null;
      lastRevokeAlertReason?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE grants
      SET
        status = ?,
        revoked_at = ?,
        revoke_attempt_count = ?,
        next_revoke_attempt_at = ?,
        last_error_code = ?,
        last_error_message = ?,
        last_alerted_at = COALESCE(?, last_alerted_at),
        alert_attempt_count = COALESCE(?, alert_attempt_count),
        last_revoke_alert_at = COALESCE(?, last_revoke_alert_at),
        last_revoke_alert_reason = COALESCE(?, last_revoke_alert_reason),
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        params.status,
        params.revokedAt,
        params.attemptCount,
        params.nextAttemptAt,
        params.errorCode,
        params.errorMessage,
        params.lastAlertedAt !== undefined ? params.lastAlertedAt : null,
        params.alertAttemptCount !== undefined
          ? params.alertAttemptCount
          : null,
        params.lastRevokeAlertAt !== undefined
          ? params.lastRevokeAlertAt
          : null,
        params.lastRevokeAlertReason !== undefined
          ? params.lastRevokeAlertReason
          : null,
        now,
        id,
      );
  }

  /**
   * Update mutation intent status.
   */
  updateMutationState(
    id: string,
    params: {
      membershipMutationState: string;
      membershipAddAttemptedAt?: string | null;
      membershipAddOperationId?: string | null;
      membershipAddLastVerifiedAt?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE grants
      SET
        membership_mutation_state = ?,
        membership_add_attempted_at = COALESCE(?, membership_add_attempted_at),
        membership_add_operation_id = COALESCE(?, membership_add_operation_id),
        membership_add_last_verified_at = COALESCE(?, membership_add_last_verified_at),
        updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        params.membershipMutationState,
        params.membershipAddAttemptedAt !== undefined
          ? params.membershipAddAttemptedAt
          : null,
        params.membershipAddOperationId !== undefined
          ? params.membershipAddOperationId
          : null,
        params.membershipAddLastVerifiedAt !== undefined
          ? params.membershipAddLastVerifiedAt
          : null,
        now,
        id,
      );
  }

  /**
   * Check if there are active (not expired) requests associated with this grant.
   */
  hasActiveRequests(grantId: string, nowStr: string): boolean {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) as count FROM grant_requests gr
      JOIN access_requests ar ON gr.access_request_id = ar.id
      WHERE gr.grant_id = ?
        AND gr.requested_expires_at > ?
        AND ar.decision_status = 'approved'
    `,
      )
      .get(grantId, nowStr) as { count: number };
    return row.count > 0;
  }

  /**
   * Find an active grant matching Org-Team-User.
   */
  findActiveGrant(
    orgId: number,
    teamId: number,
    userId: number,
  ): DbGrant | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM grants
      WHERE github_org_id = ?
        AND target_team_id = ?
        AND github_user_id = ?
        AND status IN ('pending', 'active', 'revoking', 'revoke_failed')
    `,
      )
      .get(orgId, teamId, userId);
    return (row as DbGrant) || null;
  }

  /**
   * Link an access request to a grant.
   */
  createGrantRequest(
    grantId: string,
    requestId: string,
    requestedExpiresAt: string,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO grant_requests (
        grant_id, access_request_id, requested_expires_at, created_at
      ) VALUES (?, ?, ?, ?)
    `,
      )
      .run(grantId, requestId, requestedExpiresAt, now);
  }

  /**
   * List requests linked to a grant.
   */
  listGrantRequests(grantId: string): Array<{
    grant_id: string;
    access_request_id: string;
    requested_expires_at: string;
  }> {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM grant_requests WHERE grant_id = ?
    `,
      )
      .all(grantId);
    return rows as Array<{
      grant_id: string;
      access_request_id: string;
      requested_expires_at: string;
    }>;
  }

  /**
   * Update the effective expiration date of a grant.
   */
  updateGrantExpiresAt(grantId: string, expiresAt: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE grants
      SET effective_expires_at = ?,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(expiresAt, now, grantId);
  }

  /**
   * Update grant status and preexisting membership info.
   *
   * membership_created_by_app is deliberately monotonic: once a grant is known
   * to wrap a membership LightGrant did not create (0), no later write may
   * promote it to app-created (1). Callers re-derive this flag from live GitHub
   * state on paths such as reactivation, where a stale or absent observation
   * would otherwise mark a permanent member as app-created and expose them to
   * automatic removal. Downgrading 1 -> 0 stays allowed: that direction only
   * ever widens protection. preexisting_role is preserved for the same reason.
   */
  updateGrantStatusAndMembership(
    grantId: string,
    status: string,
    membershipCreatedByApp: number,
    preexistingRole: string | null,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE grants
      SET status = ?,
          membership_created_by_app = CASE
            WHEN membership_created_by_app = 0 THEN 0
            ELSE ?
          END,
          preexisting_role = CASE
            WHEN membership_created_by_app = 0 THEN COALESCE(?, preexisting_role)
            ELSE ?
          END,
          granted_at = COALESCE(granted_at, ?),
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(
        status,
        membershipCreatedByApp,
        preexistingRole,
        preexistingRole,
        now,
        now,
        grantId,
      );
  }

  /**
   * Reactivate an existing grant by setting to pending and reactivation_required,
   * clearing revoke attempt count and scheduling.
   */
  reactivateGrant(
    grantId: string,
    expiresAt: string,
    mutationState: string,
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE grants
      SET status = 'pending',
          effective_expires_at = ?,
          membership_mutation_state = ?,
          next_revoke_attempt_at = NULL,
          revoke_attempt_count = 0,
          revoked_at = NULL,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(expiresAt, mutationState, now, grantId);
  }
}
