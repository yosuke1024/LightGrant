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
   * Mark the OAuth state session as used/consumed.
   */
  markAsUsed(id: string, timestamp: string): void {
    this.db
      .prepare(
        `
      UPDATE oauth_states
      SET used_at = ?
      WHERE id = ?
    `,
      )
      .run(timestamp, id);
  }
}
