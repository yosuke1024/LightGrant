import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { runMigrations } from "../../src/persistence/migrations.js";
import { AuditRepository } from "../../src/persistence/repositories/audit-repository.js";

describe("AuditRepository", () => {
  const tempDbPath = path.resolve("./tests/audit-repo-test.sqlite");
  let db: Database.Database;
  let auditRepo: AuditRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    auditRepo = new AuditRepository(db);
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  beforeEach(() => {
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should calculate correct previous_hash and event_hash in order", () => {
    const id1 = auditRepo.writeEventTx({
      eventType: "test_event_1",
      actorType: "system",
      payloadJson: '{"step":1}',
    });

    const id2 = auditRepo.writeEventTx({
      eventType: "test_event_2",
      actorType: "user",
      payloadJson: '{"step":2}',
    });

    const allEvents = auditRepo.listAllEvents();
    expect(allEvents).toHaveLength(2);

    const ev1 = allEvents[0];
    const ev2 = allEvents[1];

    expect(ev1.previous_hash).toBeNull();
    expect(ev2.previous_hash).toBe(ev1.event_hash);

    const validation = auditRepo.verifyChain();
    expect(validation.success).toBe(true);
  });

  it("should fail validation if an event hash is tampered", () => {
    const id1 = auditRepo.writeEventTx({
      eventType: "test_event_1",
      actorType: "system",
      payloadJson: '{"step":1}',
    });

    auditRepo.writeEventTx({
      eventType: "test_event_2",
      actorType: "user",
      payloadJson: '{"step":2}',
    });

    // Tamper the payload in DB directly by targeting event_id
    db.prepare(
      "UPDATE audit_events SET payload_json = ? WHERE event_id = ?",
    ).run('{"step":999}', id1);

    const validation = auditRepo.verifyChain();
    expect(validation.success).toBe(false);
    expect(validation.message).toContain("Hash mismatch at sequence");
  });

  it("should fail validation if previous_hash sequence is broken", () => {
    const id1 = auditRepo.writeEventTx({
      eventType: "test_event_1",
      actorType: "system",
      payloadJson: '{"step":1}',
    });

    const id2 = auditRepo.writeEventTx({
      eventType: "test_event_2",
      actorType: "user",
      payloadJson: '{"step":2}',
    });

    // Tamper the previous_hash in DB directly by targeting event_id of second event
    db.prepare(
      "UPDATE audit_events SET previous_hash = ? WHERE event_id = ?",
    ).run("fake_previous_hash", id2);

    const validation = auditRepo.verifyChain();
    expect(validation.success).toBe(false);
    expect(validation.message).toContain("Chain link broken at sequence");
  });
});
