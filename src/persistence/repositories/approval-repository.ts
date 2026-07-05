import Database from "better-sqlite3";

export interface DbApproval {
  id: string;
  access_request_id: string;
  decision: string; // 'approved' | 'denied'
  approver_identity_id: string;
  approver_github_user_id: number;
  authority_role: string; // 'maintainer' | 'admin' | 'owner'
  authority_verified_at: string;
  reason: string | null;
  created_at: string;
}

export interface CreateApprovalInput {
  id: string;
  accessRequestId: string;
  decision: string;
  approverIdentityId: string;
  approverGithubUserId: number;
  authorityRole: string;
  authorityVerifiedAt: string;
  reason: string | null;
  createdAt: string;
}

/**
 * Handles operations on the `approvals` table in SQLite.
 */
export class ApprovalRepository {
  constructor(private db: Database.Database) {}

  /**
   * Insert a new approval or denial record.
   */
  createApproval(input: CreateApprovalInput): void {
    this.db
      .prepare(
        `
      INSERT INTO approvals (
        id,
        access_request_id,
        decision,
        approver_identity_id,
        approver_github_user_id,
        authority_role,
        authority_verified_at,
        reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        input.id,
        input.accessRequestId,
        input.decision,
        input.approverIdentityId,
        input.approverGithubUserId,
        input.authorityRole,
        input.authorityVerifiedAt,
        input.reason,
        input.createdAt,
      );
  }

  /**
   * Get all approvals/denials for a specific request.
   */
  getApprovalsForRequest(requestId: string): DbApproval[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM approvals WHERE access_request_id = ?
    `,
      )
      .all(requestId);
    return rows as DbApproval[];
  }
}
