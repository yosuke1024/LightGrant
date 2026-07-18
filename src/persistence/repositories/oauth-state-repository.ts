import Database from "better-sqlite3";

export interface DbOAuthState {
  id: string;
  nonce_hash: string;
  slack_workspace_id: string;
  slack_user_id: string;
  resume_action_type: string | null;
  resume_action_id: string | null;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  oidc_nonce_hash: string | null;
  slack_verified_at: string | null;
  binding_token_hash: string | null;
}

export class OAuthStateRepository {
  constructor(private db: Database.Database) {}

  /**
   * Create a new OAuth state session record.
   */
  createState(
    id: string,
    nonceHash: string,
    workspaceId: string,
    userId: string,
    resumeActionType: string | null,
    resumeActionId: string | null,
    expiresAt: string,
    timestamp: string,
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO oauth_states (
        id, nonce_hash, slack_workspace_id, slack_user_id, resume_action_type, resume_action_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        nonceHash,
        workspaceId,
        userId,
        resumeActionType,
        resumeActionId,
        expiresAt,
        timestamp,
      );
  }

  /**
   * Retrieve an OAuth state session by ID.
   */
  getState(id: string): DbOAuthState | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM oauth_states WHERE id = ?
    `,
      )
      .get(id);
    return (row as DbOAuthState) || null;
  }

  /**
   * Retrieve an OAuth state session by nonce hash.
   */
  getStateByNonceHash(nonceHash: string): DbOAuthState | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM oauth_states WHERE nonce_hash = ?
    `,
      )
      .get(nonceHash);
    return (row as DbOAuthState) || null;
  }

  /**
   * State machine for a single account-link flow, enforced entirely with
   * compare-and-swap UPDATEs so concurrent starts/callbacks (including across
   * multiple processes sharing the SQLite file) can never double-advance it:
   *
   *   unstarted  --beginSlackOidc-->  oidc_pending
   *   oidc_pending  --completeSlackVerification-->  slack_verified
   *   slack_verified  --consumeVerifiedState-->  consumed
   *
   * Each method mutates only rows still in the expected source state and
   * returns whether exactly one row transitioned. `now` is an ISO-8601 UTC
   * timestamp; expires_at is stored in the same format so lexical comparison
   * is chronological.
   */

  /**
   * unstarted -> oidc_pending. Records the OIDC nonce hash for the pending
   * "Sign in with Slack" leg. Succeeds only for a fresh, unexpired row that has
   * not already started, been verified, or been consumed — so a second
   * /auth/github/start for the same state cannot overwrite the pending nonce.
   */
  beginSlackOidc(id: string, oidcNonceHash: string, now: string): boolean {
    const info = this.db
      .prepare(
        `
      UPDATE oauth_states
      SET oidc_nonce_hash = ?
      WHERE id = ?
        AND used_at IS NULL
        AND slack_verified_at IS NULL
        AND oidc_nonce_hash IS NULL
        AND expires_at > ?
    `,
      )
      .run(oidcNonceHash, id, now);
    return info.changes === 1;
  }

  /**
   * oidc_pending -> slack_verified. Atomically verifies the OIDC nonce and
   * records the one-time browser-binding token hash in the SAME statement, so
   * the nonce check and the state transition cannot be split by a concurrent
   * request. Fails closed when no nonce was recorded (a state that skipped
   * /auth/github/start: `oidc_nonce_hash IS NULL` can never equal the presented
   * hash) or when the presented nonce hash does not match. The nonce is cleared
   * on success so a replayed authorization code cannot re-verify.
   */
  completeSlackVerification(
    id: string,
    expectedNonceHash: string,
    bindingTokenHash: string,
    verifiedAt: string,
    now: string,
  ): boolean {
    const info = this.db
      .prepare(
        `
      UPDATE oauth_states
      SET slack_verified_at = ?, binding_token_hash = ?, oidc_nonce_hash = NULL
      WHERE id = ?
        AND used_at IS NULL
        AND slack_verified_at IS NULL
        AND oidc_nonce_hash = ?
        AND expires_at > ?
    `,
      )
      .run(verifiedAt, bindingTokenHash, id, expectedNonceHash, now);
    return info.changes === 1;
  }

  /**
   * slack_verified -> consumed. Atomically confirms the browser-binding token
   * and marks the state used in one statement, so two GitHub callbacks racing
   * with the same cookie can never both proceed. Succeeds only for a verified,
   * unexpired, not-yet-consumed row whose stored binding hash matches. Clears
   * the binding hash so the one-time cookie can never link again.
   */
  consumeVerifiedState(
    id: string,
    expectedBindingTokenHash: string,
    consumedAt: string,
    now: string,
  ): boolean {
    const info = this.db
      .prepare(
        `
      UPDATE oauth_states
      SET used_at = ?, binding_token_hash = NULL
      WHERE id = ?
        AND used_at IS NULL
        AND slack_verified_at IS NOT NULL
        AND binding_token_hash = ?
        AND expires_at > ?
    `,
      )
      .run(consumedAt, id, expectedBindingTokenHash, now);
    return info.changes === 1;
  }
}
