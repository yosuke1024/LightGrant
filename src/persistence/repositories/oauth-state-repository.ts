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
   * Record the OIDC nonce hash for the pending "Sign in with Slack" leg.
   * Called at /auth/github/start before redirecting the browser to Slack.
   */
  setOidcNonceHash(id: string, oidcNonceHash: string): void {
    this.db
      .prepare(
        `
      UPDATE oauth_states
      SET oidc_nonce_hash = ?
      WHERE id = ?
    `,
      )
      .run(oidcNonceHash, id);
  }

  /**
   * Mark this flow as Slack-verified and store the one-time browser-binding
   * token hash. Only rows that are still unverified and unused are updated, so
   * the OIDC leg is idempotent and cannot be re-driven onto a consumed state.
   * Returns true when a row was actually transitioned.
   */
  markSlackVerified(
    id: string,
    verifiedAt: string,
    bindingTokenHash: string,
  ): boolean {
    const info = this.db
      .prepare(
        `
      UPDATE oauth_states
      SET slack_verified_at = ?, binding_token_hash = ?
      WHERE id = ? AND used_at IS NULL AND slack_verified_at IS NULL
    `,
      )
      .run(verifiedAt, bindingTokenHash, id);
    return info.changes > 0;
  }

  /**
   * Mark the OAuth state session as used/consumed. Also clears the binding
   * token hash: once consumed the one-time cookie must never link again.
   */
  markAsUsed(id: string, timestamp: string): void {
    this.db
      .prepare(
        `
      UPDATE oauth_states
      SET used_at = ?, binding_token_hash = NULL
      WHERE id = ?
    `,
      )
      .run(timestamp, id);
  }
}
