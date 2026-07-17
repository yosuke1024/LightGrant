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
  /** When this grant entered 'revoking'; the lease held by that revocation. */
  revoking_started_at: string | null;
  /**
   * Unique fencing token for the revocation run that currently owns this
   * grant. Only the holder of this id may perform the destructive GitHub call
   * and the terminal DB write; a worker whose id no longer matches has lost
   * the lease and must abort.
   */
  revoking_lease_id: string | null;
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
 * Outcome of an atomic successful-revoke settlement. See
 * {@link GrantRepository.finalizeSuccessfulRevoke}.
 */
export type SuccessfulRevokeOutcome =
  "revoked" | "reactivation_pending" | "lease_lost";

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
   *
   * Grants parked in 'revoking' are included once their revoke lease has gone
   * stale. A revocation that dies partway through leaves the grant in that
   * state, and without this sweep nothing would ever select it again: the
   * grant would keep its access forever. A lease newer than
   * staleRevokingBefore means a revocation is still in flight, so it is left
   * alone. A missing lease records no live claim and is reclaimable.
   *
   * @param staleRevokingBefore ISO instant; 'revoking' grants leased at or
   * before this are considered abandoned.
   */
  getExpiredGrants(nowStr: string, staleRevokingBefore: string): DbGrant[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM grants
      WHERE status IN ('active', 'revoke_failed', 'already_present', 'revoking')
        AND effective_expires_at <= ?
        AND (
          status IN ('active', 'already_present')
          OR (status = 'revoke_failed' AND next_revoke_attempt_at <= ?)
          OR (
            status = 'revoking'
            AND (revoking_started_at IS NULL OR revoking_started_at <= ?)
          )
        )
        AND revoked_at IS NULL
    `,
      )
      .all(nowStr, nowStr, staleRevokingBefore);
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
   * Take the revoke lease for a grant, stamping a fresh fencing token.
   *
   * A grant is leasable when it is in a revocable state, or already in
   * 'revoking' but with a stale/absent lease (its previous owner died). The
   * update is a Compare-and-Set: it succeeds for exactly one racing worker and
   * hands that worker a unique `leaseId` that fences every later step of its
   * run. A revocation still in flight (fresh lease) is left untouched.
   *
   * @param staleRevokingBefore ISO instant; a 'revoking' lease taken at or
   * before this counts as abandoned and may be reclaimed.
   * @returns true when this caller took the lease.
   */
  acquireRevokeLease(
    id: string,
    leaseId: string,
    nowStr: string,
    staleRevokingBefore: string,
  ): boolean {
    const result = this.db
      .prepare(
        `
      UPDATE grants
      SET status = 'revoking',
          revoking_started_at = ?,
          revoking_lease_id = ?,
          updated_at = ?
      WHERE id = ?
        AND (
          status IN ('active', 'revoke_failed', 'already_present')
          OR (
            status = 'revoking'
            AND (revoking_started_at IS NULL OR revoking_started_at <= ?)
          )
        )
    `,
      )
      .run(nowStr, leaseId, nowStr, id, staleRevokingBefore);
    return result.changes === 1;
  }

  /**
   * Whether this run still owns the revoke lease for a grant.
   *
   * Ownership means the grant is still 'revoking', still carries this run's
   * fencing token, and the lease has not gone stale. Callers check this
   * immediately before an irreversible GitHub mutation so a worker that lost
   * its lease never removes a member the current owner may have already
   * reinstated.
   */
  ownsRevokeLease(
    id: string,
    leaseId: string,
    staleRevokingBefore: string,
  ): boolean {
    const row = this.db
      .prepare(
        `
      SELECT 1 AS present FROM grants
      WHERE id = ?
        AND status = 'revoking'
        AND revoking_lease_id = ?
        AND revoking_started_at IS NOT NULL
        AND revoking_started_at > ?
    `,
      )
      .get(id, leaseId, staleRevokingBefore);
    return !!row;
  }

  /**
   * Write a terminal revocation outcome, but only if this run still holds the
   * lease. The fencing predicate (status = 'revoking', matching lease id, lease
   * not stale) makes the write a no-op for a worker whose lease was reclaimed,
   * so it can never overwrite the new owner's result or a later reactivation.
   * On success the lease is released (both lease columns cleared) since the
   * grant is leaving 'revoking'.
   *
   * @returns true when the fenced write landed; false means the lease was lost
   * and the caller must stop without side effects.
   */
  finalizeRevocationWithLease(
    id: string,
    leaseId: string,
    staleRevokingBefore: string,
    params: {
      status: string;
      revokedAt: string | null;
      attemptCount: number;
      nextAttemptAt: string | null;
      errorCode: string | null;
      errorMessage: string | null;
    },
  ): boolean {
    const now = new Date().toISOString();
    const result = this.db
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
        revoking_started_at = NULL,
        revoking_lease_id = NULL,
        updated_at = ?
      WHERE id = ?
        AND status = 'revoking'
        AND revoking_lease_id = ?
        AND revoking_started_at IS NOT NULL
        AND revoking_started_at > ?
    `,
      )
      .run(
        params.status,
        params.revokedAt,
        params.attemptCount,
        params.nextAttemptAt,
        params.errorCode,
        params.errorMessage,
        now,
        id,
        leaseId,
        staleRevokingBefore,
      );
    return result.changes === 1;
  }

  /**
   * Atomically settle a successful revocation (membership removed or already
   * absent), deciding in ONE fenced step between finalizing 'revoked' and
   * handing the grant back to reactivation.
   *
   * Why this is a single operation rather than "check reactivation, then
   * finalize": a request that reactivates the grant can commit in the gap
   * between those two writes. If it does, a separate finalize would still set
   * status='revoked' with a revoked_at, while grant_access re-adds the
   * membership and never clears revoked_at — so getExpiredGrants()
   * (`revoked_at IS NULL`) can never reclaim it again and the JIT grant becomes
   * permanent. Testing `membership_mutation_state` inside the very UPDATE that
   * performs the transition closes that TOCTOU: the reactivation is either
   * already visible (we hand back) or not yet committed (we finalize revoked),
   * with no window in between.
   *
   * Both branches are fenced by the lease (status='revoking', matching token,
   * lease not stale) so a worker that lost the lease no-ops and returns
   * 'lease_lost'. The reactivation branch wins over the revoked branch when a
   * reactivation is pending. Callers MUST run this inside the same transaction
   * as the outcome's audit event / jobs so state and audit commit atomically.
   *
   * @returns
   *  - 'reactivation_pending' — a request asked for the grant back; moved to
   *    'pending' (revoked_at left NULL) for grant_access to re-add membership.
   *  - 'revoked' — no reactivation pending; finalized terminal 'revoked'.
   *  - 'lease_lost' — the lease was reclaimed/stale; nothing was written.
   */
  finalizeSuccessfulRevoke(
    id: string,
    leaseId: string,
    staleRevokingBefore: string,
    revokedAt: string,
  ): SuccessfulRevokeOutcome {
    const now = new Date().toISOString();

    // Reactivation branch: fenced AND gated on a pending reactivation. Wins
    // over the revoked branch below when a request has asked for the grant
    // back. Keeps the (already extended) expiry and clears revoke bookkeeping.
    const reactivated = this.db
      .prepare(
        `
      UPDATE grants
      SET status = 'pending',
          next_revoke_attempt_at = NULL,
          revoke_attempt_count = 0,
          revoked_at = NULL,
          revoking_started_at = NULL,
          revoking_lease_id = NULL,
          updated_at = ?
      WHERE id = ?
        AND status = 'revoking'
        AND revoking_lease_id = ?
        AND revoking_started_at IS NOT NULL
        AND revoking_started_at > ?
        AND membership_mutation_state = 'reactivation_required'
    `,
      )
      .run(now, id, leaseId, staleRevokingBefore);
    if (reactivated.changes === 1) return "reactivation_pending";

    // Revoked branch: fenced AND gated on NO pending reactivation. Because a
    // write transaction holds the SQLite write lock from the statement above
    // until commit, no reactivation can slip in between the two UPDATEs.
    const revoked = this.db
      .prepare(
        `
      UPDATE grants
      SET status = 'revoked',
          revoked_at = ?,
          revoke_attempt_count = 0,
          next_revoke_attempt_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          revoking_started_at = NULL,
          revoking_lease_id = NULL,
          updated_at = ?
      WHERE id = ?
        AND status = 'revoking'
        AND revoking_lease_id = ?
        AND revoking_started_at IS NOT NULL
        AND revoking_started_at > ?
        AND membership_mutation_state != 'reactivation_required'
    `,
      )
      .run(revokedAt, now, id, leaseId, staleRevokingBefore);
    if (revoked.changes === 1) return "revoked";

    return "lease_lost";
  }

  /**
   * Take over a grant stranded in 'revoking' with a pending reactivation whose
   * revoke worker died (its lease has gone stale). This is grant_access's
   * recovery hook: it reclaims the grant to 'pending' so the reactivation flow
   * can proceed. Gated on a stale/absent lease so it never races a revocation
   * that is still in flight, and on reactivation_required so it only ever
   * rescues grants a request is actively trying to restore.
   *
   * @returns true when the takeover landed.
   */
  reclaimStrandedReactivation(
    id: string,
    staleRevokingBefore: string,
  ): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
      UPDATE grants
      SET status = 'pending',
          next_revoke_attempt_at = NULL,
          revoke_attempt_count = 0,
          revoked_at = NULL,
          revoking_started_at = NULL,
          revoking_lease_id = NULL,
          updated_at = ?
      WHERE id = ?
        AND status = 'revoking'
        AND membership_mutation_state = 'reactivation_required'
        AND (revoking_started_at IS NULL OR revoking_started_at <= ?)
    `,
      )
      .run(now, id, staleRevokingBefore);
    return result.changes === 1;
  }

  /**
   * Release the revoke lease without changing status. Used when a revocation is
   * cancelled in place (a new active request arrives) so a returning zombie
   * cannot match the token that governed the abandoned run.
   */
  clearRevokeLease(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE grants
      SET revoking_started_at = NULL,
          revoking_lease_id = NULL,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(now, id);
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
   * Take ownership of a membership this app just created and verified.
   *
   * This is the only sanctioned way to promote membership_created_by_app from
   * 0 to 1, which updateGrantStatusAndMembership deliberately forbids. A grant
   * that previously wrapped a preexisting membership can legitimately come to
   * wrap an app-created one: the user leaves the team, a later request finds
   * the membership absent, and LightGrant adds them back. That new membership
   * is ours to revoke, and the stale preexisting_role must not outlive it.
   *
   * Promotion is gated on membership_mutation_state = 'add_request_sent' so it
   * can only follow an add this app actually issued in the same run. Callers
   * must therefore have observed absence, called addTeamMember successfully,
   * and re-verified the membership live. It must NOT be used where membership
   * was merely observed — reactivation re-checks, membership_confirmed
   * revalidation, or recovery after an add whose outcome is unknown — since
   * there the membership may be the user's own permanent one.
   *
   * @returns true when the grant was promoted; false when the CAS did not
   * match, leaving the caller to fall back to a non-promoting update.
   */
  confirmMembershipCreatedByAppAfterVerifiedAdd(
    grantId: string,
    verifiedAt: string,
  ): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `
      UPDATE grants
      SET status = 'active',
          membership_created_by_app = 1,
          preexisting_role = NULL,
          membership_mutation_state = 'membership_confirmed',
          membership_add_last_verified_at = ?,
          granted_at = COALESCE(granted_at, ?),
          updated_at = ?
      WHERE id = ?
        AND membership_mutation_state = 'add_request_sent'
    `,
      )
      .run(verifiedAt, now, now, grantId);
    return result.changes === 1;
  }

  /**
   * Reactivate an existing grant by setting to pending and reactivation_required,
   * clearing revoke attempt count and scheduling.
   *
   * Reactivation also releases any revoke lease (revoking_started_at /
   * revoking_lease_id). A grant may be reactivated while a stale revocation is
   * still in flight; clearing the lease explicitly expires that run, so a
   * worker returning from the abandoned revoke can no longer match the token
   * and remove the member this reactivation just kept.
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
          revoking_started_at = NULL,
          revoking_lease_id = NULL,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(expiresAt, mutationState, now, grantId);
  }
}
