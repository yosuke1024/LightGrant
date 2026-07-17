import Database from "better-sqlite3";
import crypto from "crypto";

export interface DbJob {
  id: string;
  type: string;
  payload_json: string;
  status: string; // 'queued' | 'running' | 'completed' | 'failed'
  attempt_count: number;
  run_after: string;
  locked_at: string | null;
  locked_by: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface CreateJobInput {
  id: string;
  type: string;
  payloadJson: string;
  runAfter: string;
}

export class JobRepository {
  constructor(private db: Database.Database) {}

  /**
   * Enqueue a validation job to verify active policy owners.
   */
  enqueuePolicyValidationJob(): string {
    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.createJob({
      id: jobId,
      type: "validate_policy_authority",
      payloadJson: "{}",
      runAfter: now,
    });
    return jobId;
  }

  /**
   * Insert a new job to the queued state.
   */
  createJob(input: CreateJobInput): void {
    const now = new Date().toISOString();
    let payloadJson = input.payloadJson;

    try {
      const payload = JSON.parse(input.payloadJson);
      if (!payload.idempotencyKey) {
        if (input.type === "notify_request_result") {
          const { requestId, status } = payload;
          if (requestId && status) {
            let key = "";
            if (status === "approved" || status === "already_present") {
              key = `request_granted:${requestId}`;
            } else if (status === "revoked") {
              key = `grant_revoked:${requestId}`;
            } else {
              key = `request_failed:${requestId}`;
            }
            payload.idempotencyKey = key;
            payloadJson = JSON.stringify(payload);
          }
        } else if (input.type === "post_audit_notification") {
          const { status, grantId, requestId, eventId } = payload;
          let key = "";
          if (status === "failed") {
            const alertWindow = Math.floor(Date.now() / (5 * 60 * 1000));
            key = `revoke_failed_alert:${grantId || requestId}:${alertWindow}`;
          } else {
            key = `audit_event:${eventId || requestId || crypto.randomUUID()}`;
          }
          payload.idempotencyKey = key;
          payloadJson = JSON.stringify(payload);
        }
      }
    } catch {
      // Ignore JSON parse errors and proceed
    }

    this.db
      .prepare(
        `
      INSERT INTO jobs (
        id, type, payload_json, status, attempt_count, run_after, created_at, updated_at
      ) VALUES (?, ?, ?, 'queued', 0, ?, ?, ?)
    `,
      )
      .run(input.id, input.type, payloadJson, input.runAfter, now, now);
  }

  /**
   * Safe compare-and-set acquisition of jobs.
   * Recovers stale jobs, finds queued runnable jobs, and locks them.
   */
  acquireNextJobs(
    lockedBy: string,
    limit: number,
    leaseDurationSeconds: number,
  ): DbJob[] {
    const now = new Date().toISOString();
    const staleTime = new Date(
      Date.now() - leaseDurationSeconds * 1000,
    ).toISOString();

    const acquireTx = this.db.transaction(() => {
      // 1. Automatically recover stale running jobs
      this.db
        .prepare(
          `
        UPDATE jobs
        SET status = 'queued', locked_at = NULL, locked_by = NULL, updated_at = ?
        WHERE status = 'running' AND locked_at <= ?
      `,
        )
        .run(now, staleTime);

      // 2. Select next available queued jobs
      const candidates = this.db
        .prepare(
          `
        SELECT * FROM jobs
        WHERE status = 'queued' AND run_after <= ?
        ORDER BY run_after ASC, created_at ASC
        LIMIT ?
      `,
        )
        .all(now, limit) as DbJob[];

      const lockedJobs: DbJob[] = [];
      const updateStmt = this.db.prepare(`
        UPDATE jobs
        SET status = 'running',
            locked_at = ?,
            locked_by = ?,
            attempt_count = attempt_count + 1,
            updated_at = ?
        WHERE id = ? AND status = 'queued'
      `);

      for (const job of candidates) {
        const result = updateStmt.run(now, lockedBy, now, job.id);
        if (result.changes === 1) {
          lockedJobs.push({
            ...job,
            status: "running",
            locked_at: now,
            locked_by: lockedBy,
            attempt_count: job.attempt_count + 1,
            updated_at: now,
          });
        }
      }

      return lockedJobs;
    });

    return acquireTx();
  }

  /**
   * Mark a job completed.
   */
  completeJob(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE jobs
      SET status = 'completed',
          completed_at = ?,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(now, now, id);
  }

  /**
   * Release a failed job back to queued status for retry.
   */
  releaseJobForRetry(id: string, nextRunAfter: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE jobs
      SET status = 'queued',
          run_after = ?,
          last_error = ?,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(nextRunAfter, error, now, id);
  }

  /**
   * Re-queue a job to run later WITHOUT charging it a retry attempt.
   *
   * Acquisition increments attempt_count up front, so a plain reschedule would
   * burn the attempt budget while a job is merely waiting on a precondition
   * (e.g. grant_access waiting for an in-flight revocation to settle). This
   * decrements attempt_count to offset the acquisition bump, so an unbounded
   * wait never trips the max-attempts permanent failure. Not a failure path:
   * it records the deferral reason but leaves the job runnable.
   */
  deferJob(id: string, nextRunAfter: string, reason: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE jobs
      SET status = 'queued',
          run_after = ?,
          last_error = ?,
          attempt_count = MAX(attempt_count - 1, 0),
          locked_at = NULL,
          locked_by = NULL,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(nextRunAfter, reason, now, id);
  }

  /**
   * Mark a job permanently failed.
   */
  failJob(id: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      UPDATE jobs
      SET status = 'failed',
          last_error = ?,
          locked_at = NULL,
          locked_by = NULL,
          updated_at = ?
      WHERE id = ?
    `,
      )
      .run(error, now, id);
  }
}
