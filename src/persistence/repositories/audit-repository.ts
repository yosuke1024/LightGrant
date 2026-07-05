import Database from "better-sqlite3";
import crypto from "crypto";
import { canonicalJson, sha256 } from "../../security/hashing.js";

export interface DbAuditEvent {
  sequence_number: number;
  event_id: string;
  event_type: string;
  occurred_at: string;
  actor_type: string; // 'user' | 'system' | 'github_webhook'
  actor_id: string | null;
  slack_workspace_id: string | null;
  slack_user_id: string | null;
  github_org_id: number | null;
  github_user_id: number | null;
  github_team_id: number | null;
  access_request_id: string | null;
  grant_id: string | null;
  policy_id: string | null;
  policy_version: number | null;
  correlation_id: string;
  payload_json: string;
  previous_hash: string | null;
  event_hash: string;
  created_at: string;
}

export interface DbExportToken {
  token_hash: string;
  slack_workspace_id: string;
  slack_user_id: string;
  file_path: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  file_id: string | null;
  download_started_at?: string | null;
  download_lease_expires_at?: string | null;
}

export class AuditRepository {
  constructor(private db: Database.Database) {}

  /**
   * Write a new audit event within a transaction.
   * Deterministically calculates previous_hash and event_hash.
   */
  writeEventTx(event: {
    eventId?: string;
    eventType: string;
    occurredAt?: string;
    actorType: string;
    actorId?: string | null;
    slackWorkspaceId?: string | null;
    slackUserId?: string | null;
    githubOrgId?: number | null;
    githubUserId?: number | null;
    githubTeamId?: number | null;
    accessRequestId?: string | null;
    grantId?: string | null;
    policyId?: string | null;
    policyVersion?: number | null;
    correlationId?: string;
    payloadJson?: string;
  }): string {
    const eventId = event.eventId || crypto.randomUUID();
    const occurredAt = event.occurredAt || new Date().toISOString();
    const correlationId = event.correlationId || crypto.randomUUID();
    const payloadJson = event.payloadJson || "{}";

    // 1. Resolve previous hash (most recent event_hash ordered by sequence_number DESC)
    const prevRow = this.db
      .prepare(
        `
      SELECT event_hash FROM audit_events 
      ORDER BY sequence_number DESC LIMIT 1
    `,
      )
      .get() as { event_hash: string } | undefined;

    const previousHash = prevRow ? prevRow.event_hash : "";

    // 2. Build canonical object
    const canonicalObject = {
      event_id: eventId,
      event_type: event.eventType,
      occurred_at: occurredAt,
      actor_type: event.actorType,
      actor_id: event.actorId || null,
      slack_workspace_id: event.slackWorkspaceId || null,
      slack_user_id: event.slackUserId || null,
      github_org_id: event.githubOrgId || null,
      github_user_id: event.githubUserId || null,
      github_team_id: event.githubTeamId || null,
      access_request_id: event.accessRequestId || null,
      grant_id: event.grantId || null,
      policy_id: event.policyId || null,
      policy_version: event.policyVersion || null,
      correlation_id: correlationId,
      payload_json: payloadJson,
      previous_hash: previousHash,
    };

    // 3. Compute current event SHA-256 hash
    const eventHash = sha256(canonicalJson(canonicalObject));
    const now = new Date().toISOString();

    // 4. Insert into DB
    this.db
      .prepare(
        `
      INSERT INTO audit_events (
        event_id, event_type, occurred_at, actor_type, actor_id,
        slack_workspace_id, slack_user_id, github_org_id, github_user_id, github_team_id,
        access_request_id, grant_id, policy_id, policy_version, correlation_id,
        payload_json, previous_hash, event_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        eventId,
        event.eventType,
        occurredAt,
        event.actorType,
        event.actorId || null,
        event.slackWorkspaceId || null,
        event.slackUserId || null,
        event.githubOrgId || null,
        event.githubUserId || null,
        event.githubTeamId || null,
        event.accessRequestId || null,
        event.grantId || null,
        event.policyId || null,
        event.policyVersion || null,
        correlationId,
        payloadJson,
        previousHash || null,
        eventHash,
        now,
      );

    return eventId;
  }

  /**
   * Verify the cryptographic hash chain of all audit events in sequence.
   * Returns validation status.
   */
  verifyChain(): { success: boolean; errorIndex?: number; message?: string } {
    const rows = this.db
      .prepare("SELECT * FROM audit_events ORDER BY sequence_number ASC")
      .all() as DbAuditEvent[];

    let expectedPrevHash = "";

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // 1. Verify previous_hash link
      const actualPrevHash = row.previous_hash || "";
      if (actualPrevHash !== expectedPrevHash) {
        return {
          success: false,
          errorIndex: i,
          message: `Chain link broken at sequence ${row.sequence_number}. Expected previous_hash: "${expectedPrevHash}", but got: "${actualPrevHash}".`,
        };
      }

      // 2. Re-compute canonical JSON hash
      const canonicalObject = {
        event_id: row.event_id,
        event_type: row.event_type,
        occurred_at: row.occurred_at,
        actor_type: row.actor_type,
        actor_id: row.actor_id,
        slack_workspace_id: row.slack_workspace_id,
        slack_user_id: row.slack_user_id,
        github_org_id: row.github_org_id,
        github_user_id: row.github_user_id,
        github_team_id: row.github_team_id,
        access_request_id: row.access_request_id,
        grant_id: row.grant_id,
        policy_id: row.policy_id,
        policy_version: row.policy_version,
        correlation_id: row.correlation_id,
        payload_json: row.payload_json,
        previous_hash: actualPrevHash,
      };

      const calculatedHash = sha256(canonicalJson(canonicalObject));

      // 3. Verify computed hash matches stored hash
      if (calculatedHash !== row.event_hash) {
        return {
          success: false,
          errorIndex: i,
          message: `Hash mismatch at sequence ${row.sequence_number}. Calculated: "${calculatedHash}", but stored: "${row.event_hash}".`,
        };
      }

      expectedPrevHash = row.event_hash;
    }

    return { success: true };
  }

  /**
   * Retrieve all audit events.
   */
  listAllEvents(): DbAuditEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM audit_events ORDER BY sequence_number ASC")
      .all();
    return (rows as DbAuditEvent[]) || [];
  }

  /**
   * Save a generated export token.
   */
  createExportToken(params: {
    tokenHash: string;
    slackWorkspaceId: string;
    slackUserId: string;
    filePath: string;
    expiresAt: string;
    fileId: string;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO export_tokens (
        token_hash, slack_workspace_id, slack_user_id, file_path, expires_at, created_at, file_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run(
        params.tokenHash,
        params.slackWorkspaceId,
        params.slackUserId,
        params.filePath,
        params.expiresAt,
        now,
        params.fileId,
      );
  }

  /**
   * Retrieve active export token by hash.
   */
  getExportToken(tokenHash: string): DbExportToken | null {
    const row = this.db
      .prepare(
        `
      SELECT * FROM export_tokens WHERE token_hash = ? AND used_at IS NULL
    `,
      )
      .get(tokenHash);
    return (row as DbExportToken) || null;
  }

  /**
   * Mark token as used.
   */
  markExportTokenUsed(tokenHash: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE export_tokens SET used_at = ? WHERE token_hash = ?
    `,
      )
      .run(now, tokenHash);
  }
}
