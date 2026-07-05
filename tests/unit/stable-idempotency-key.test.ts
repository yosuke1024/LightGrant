import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import crypto from "crypto";
import { runMigrations } from "../../src/persistence/migrations.js";
import { JobRepository } from "../../src/persistence/repositories/job-repository.js";
import { JobWorker } from "../../src/workers/job-worker.js";

describe("Stable Idempotency Key", () => {
  const tempDbPath = "./tests/stable-idempotency-key-test.sqlite";
  let db: Database.Database;
  let jobRepo: JobRepository;

  beforeAll(() => {
    db = new Database(tempDbPath);
    runMigrations(db);
    jobRepo = new JobRepository(db);
  });

  afterAll(() => {
    if (db) db.close();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM jobs").run();
    db.prepare("DELETE FROM notification_deliveries").run();
  });

  it("should automatically inject idempotencyKey on createJob in JobRepository", () => {
    const payload = {
      requestId: "req-123",
      status: "approved",
      slackUserId: "U123",
      teamName: "team-a",
    };

    jobRepo.createJob({
      id: "job-123",
      type: "notify_request_result",
      payloadJson: JSON.stringify(payload),
      runAfter: new Date().toISOString(),
    });

    const job = db.prepare("SELECT * FROM jobs WHERE id = 'job-123'").get() as any;
    expect(job).toBeDefined();

    const parsed = JSON.parse(job.payload_json);
    expect(parsed.idempotencyKey).toBe("request_granted:req-123");
  });

  it("should reuse the payload idempotencyKey and avoid duplicates across time window changes", async () => {
    const mockNotifier = {
      notifyRevocation: vi.fn(),
      postAuditRevocation: vi.fn().mockResolvedValue(undefined),
    };

    const payload = {
      eventId: "event-123",
      requestId: "req-123",
      status: "failed", // This trigger revoke_failed_alert key
      idempotencyKey: "revoke_failed_alert:req-123:fixed-window", // Preserved stable key
    };

    // 1. First execution
    db.prepare(
      `
      INSERT INTO jobs (id, type, payload_json, status, attempt_count, run_after, created_at, updated_at)
      VALUES ('job-first', 'post_audit_notification', ?, 'queued', 0, ?, ?, ?)
      `
    ).run(JSON.stringify(payload), new Date().toISOString(), new Date().toISOString(), new Date().toISOString());

    const worker = new JobWorker(db, {} as any, mockNotifier as any);
    await (worker as any).runCycle();

    // Verify first notification delivery registered
    const deliveryFirst = db.prepare("SELECT * FROM notification_deliveries WHERE idempotency_key = ?").get("revoke_failed_alert:req-123:fixed-window") as any;
    expect(deliveryFirst).toBeDefined();
    expect(deliveryFirst.status).toBe("sent");

    // 2. Second execution (retry simulation with different time window)
    // Modify job back to queued and change lock state to simulate retry
    db.prepare("UPDATE jobs SET status = 'queued', attempt_count = 0 WHERE id = 'job-first'").run();

    // Spy on date.now to pretend we are in a different 5-minute time window
    const originalNow = Date.now;
    Date.now = () => originalNow() + 10 * 60 * 1000; // 10 minutes later

    try {
      await (worker as any).runCycle();
    } finally {
      Date.now = originalNow;
    }

    // Verify no new delivery was created, and old delivery is still 'sent'
    const deliveries = db.prepare("SELECT * FROM notification_deliveries").all();
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe("sent");
  });
});
