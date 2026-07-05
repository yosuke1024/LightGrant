import Database from "better-sqlite3";

export interface DbIdentityLink {
  id: string;
  slack_workspace_id: string;
  slack_user_id: string;
  github_user_id: number;
  github_login: string;
  linked_at: string;
  last_verified_at: string;
  unlinked_at: string | null;
  created_at: string;
  updated_at: string;
}

export class IdentityRepository {
  constructor(private db: Database.Database) {}

  /**
   * Retrieve an active identity mapping link by primary key ID.
   */
  getLink(id: string): DbIdentityLink | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM identity_links
      WHERE id = ? AND unlinked_at IS NULL
    `,
      )
      .get(id);
    return (row as DbIdentityLink) || null;
  }

  /**
   * Retrieve active identity link by Slack user ID.
   */
  getLinkBySlackUser(
    workspaceId: string,
    userId: string,
  ): DbIdentityLink | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM identity_links
      WHERE slack_workspace_id = ? AND slack_user_id = ? AND unlinked_at IS NULL
    `,
      )
      .get(workspaceId, userId);
    return (row as DbIdentityLink) || null;
  }

  /**
   * Retrieve active identity link by GitHub user ID.
   */
  getLinkByGitHubUser(
    workspaceId: string,
    githubUserId: number,
  ): DbIdentityLink | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM identity_links
      WHERE slack_workspace_id = ? AND github_user_id = ? AND unlinked_at IS NULL
    `,
      )
      .get(workspaceId, githubUserId);
    return (row as DbIdentityLink) || null;
  }

  /**
   * Retrieve active identity link by GitHub user ID globally across all workspaces.
   */
  getLinkByGitHubUserGlobal(githubUserId: number): DbIdentityLink | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM identity_links
      WHERE github_user_id = ? AND unlinked_at IS NULL
      LIMIT 1
    `,
      )
      .get(githubUserId);
    return (row as DbIdentityLink) || null;
  }

  /**
   * Create a new identity link.
   */
  createLink(
    id: string,
    workspaceId: string,
    userId: string,
    githubUserId: number,
    githubLogin: string,
    timestamp: string,
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO identity_links (
        id, slack_workspace_id, slack_user_id, github_user_id, github_login, linked_at, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        id,
        workspaceId,
        userId,
        githubUserId,
        githubLogin,
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      );
  }

  /**
   * Soft delete (unlink) an identity link by setting unlinked_at.
   */
  unlink(workspaceId: string, userId: string, timestamp: string): void {
    this.db
      .prepare(
        `
      UPDATE identity_links
      SET unlinked_at = ?, updated_at = ?
      WHERE slack_workspace_id = ? AND slack_user_id = ? AND unlinked_at IS NULL
    `,
      )
      .run(timestamp, timestamp, workspaceId, userId);
  }

  /**
   * Update github_login and last_verified_at for an existing active link.
   */
  updateLastVerified(id: string, githubLogin: string, timestamp: string): void {
    this.db
      .prepare(
        `
      UPDATE identity_links
      SET github_login = ?, last_verified_at = ?, updated_at = ?
      WHERE id = ? AND unlinked_at IS NULL
    `,
      )
      .run(githubLogin, timestamp, timestamp, id);
  }
}
