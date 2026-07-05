import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { runMigrations } from "../../src/persistence/migrations.js";
import { createWebhookRouter } from "../../src/http/github-webhook-routes.js";
import { config } from "../../src/config.js";
import express from "express";
import http from "http";
import crypto from "crypto";
import { FakeGitHubClient } from "../fakes/fake-github-client.js";

describe("GitHub Webhook Integration", () => {
  const tempDbPath = path.resolve("./tests/github-webhook-test.sqlite");
  let db: Database.Database;
  let app: express.Express;
  let server: http.Server;
  let port: number;
  let fakeGitHubClient: FakeGitHubClient;

  beforeAll(async () => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);

    app = express();
    // Raw body parser verify configuration mimicking server.ts
    app.use(
      express.json({
        verify: (req: any, res, buf) => {
          const urlPath = req.originalUrl.split("?")[0];
          if (urlPath === "/github/webhooks" || urlPath === "/webhooks/github") {
            req.rawBody = Buffer.from(buf);
          }
        },
      }),
    );
    const mockOrgContext = {
      organizationId: 1111,
      organizationLogin: "test-org",
      installationId: 12345,
    };
    fakeGitHubClient = new FakeGitHubClient();
    app.use(createWebhookRouter(db, mockOrgContext, fakeGitHubClient));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address() as any;
        port = address.port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (db) {
      db.close();
    }
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  beforeEach(() => {
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM webhook_deliveries").run();
    db.prepare("DELETE FROM grants").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
    
    if (fakeGitHubClient) {
      fakeGitHubClient.teamMembers = [];
      fakeGitHubClient.calls = [];
      fakeGitHubClient.simulateRateLimit = false;
      fakeGitHubClient.simulateTransientError = false;
    }
  });

  function calculateSignature(payload: string): string {
    const hmac = crypto.createHmac("sha256", config.GITHUB_WEBHOOK_SECRET);
    hmac.update(payload);
    return `sha256=${hmac.digest("hex")}`;
  }

  it("should process valid signature webhook successfully and deduplicate on repeat", async () => {
    const payload = JSON.stringify({ action: "ping" });
    const signature = calculateSignature(payload);
    const deliveryId = crypto.randomUUID();

    // 1. Process first delivery
    const response = await fetch(`http://localhost:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("Webhook processed successfully");

    // Check delivery in DB
    const delivery = db
      .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = ?")
      .get(deliveryId) as any;
    expect(delivery).not.toBeUndefined();
    expect(delivery.status).toBe("processed");

    // 2. Try sending the same deliveryId again (Deduplication)
    const secondResponse = await fetch(
      `http://localhost:${port}/github/webhooks`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": deliveryId,
          "x-github-event": "ping",
          "x-hub-signature-256": signature,
        },
        body: payload,
      },
    );

    expect(secondResponse.status).toBe(200);
    const secondText = await secondResponse.text();
    expect(secondText).toBe("Duplicate delivery skipped");
  });

  it("should reject webhook if signature is invalid", async () => {
    const payload = JSON.stringify({ action: "ping" });
    const signature = "sha256=invalid_signature_hash_value";
    const deliveryId = crypto.randomUUID();

    const response = await fetch(`http://localhost:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).toBe("Invalid signature");
  });

  it("should sync grant status to revoked on membership removed event, writing drift event and queuing notification jobs", async () => {
    // 1. Prepare identity link & active grant in DB
    const now = new Date().toISOString();
    const identityId = crypto.randomUUID();
    db.prepare(
      `
      INSERT INTO identity_links (
        id, slack_workspace_id, slack_user_id, github_user_id, github_login, linked_at, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      identityId,
      "T_TEST_WORKSPACE",
      "U_TEST_USER",
      777,
      "test-user",
      now,
      now,
      now,
      now,
    );

    db.prepare(
      `
      INSERT INTO grants (
        id, github_org_id, target_team_id, github_user_id, github_login_snapshot, status, membership_created_by_app, effective_expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      "grant-123",
      1111,
      888,
      777,
      "test-user",
      "active",
      1,
      new Date(Date.now() + 3600000).toISOString(),
      now,
      now,
    );

    const payload = JSON.stringify({
      action: "removed",
      team: { id: 888 },
      member: { id: 777 },
      organization: { id: 1111 },
    });
    const signature = calculateSignature(payload);
    const deliveryId = crypto.randomUUID();

    // 2. Trigger membership removed Webhook
    const response = await fetch(`http://localhost:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "membership",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    if (response.status !== 200) {
      throw new Error("WEBHOOK ERROR: " + (await response.text()));
    }
    expect(response.status).toBe(200);

    // 3. Verify grant status updated to revoked (with manual removal code)
    const grant = db
      .prepare("SELECT * FROM grants WHERE id = ?")
      .get("grant-123") as any;
    expect(grant.status).toBe("revoked");
    expect(grant.last_error_code).toBe("manually_removed_from_github");

    // 4. Verify audit event was written
    const audit = db
      .prepare("SELECT * FROM audit_events WHERE event_type = ?")
      .get("grant_revoked") as any;
    expect(audit).not.toBeUndefined();
    expect(audit.grant_id).toBe("grant-123");
    expect(JSON.parse(audit.payload_json).reason).toBe(
      "manually_removed_from_github",
    );

    // 5. Verify drift detected event was written
    const driftEvent = db
      .prepare("SELECT * FROM audit_events WHERE event_type = ?")
      .get("grant.drift_detected") as any;
    expect(driftEvent).not.toBeUndefined();
    expect(driftEvent.grant_id).toBe("grant-123");
    expect(JSON.parse(driftEvent.payload_json).drift_type).toBe(
      "manual_removal_on_github",
    );

    // 6. Verify Slack notification jobs were queued
    const jobs = db
      .prepare("SELECT * FROM jobs ORDER BY type ASC")
      .all() as any[];
    expect(jobs).toHaveLength(2);
    expect(jobs[0].type).toBe("notify_request_result");
    expect(jobs[1].type).toBe("post_audit_notification");
  });

  it("should return 202 when duplicate webhook has active lease (processing)", async () => {
    const payload = JSON.stringify({ action: "ping" });
    const signature = calculateSignature(payload);
    const deliveryId = crypto.randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 10000).toISOString(); // 10s lease in future

    // Seed processing state in DB
    db.prepare(
      `
      INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, lease_expires_at, payload_json)
      VALUES ('github', ?, 'ping', ?, 'processing', ?, ?)
    `
    ).run(deliveryId, now.toISOString(), leaseExpiresAt, payload);

    const response = await fetch(`http://localhost:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(202);
    const text = await response.text();
    expect(text).toBe("Processing");
  });

  it("should recover and reprocess when lease has expired", async () => {
    const payload = JSON.stringify({ action: "ping" });
    const signature = calculateSignature(payload);
    const deliveryId = crypto.randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() - 10000).toISOString(); // 10s lease in past (expired)

    // Seed expired lease in DB
    db.prepare(
      `
      INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, lease_expires_at, payload_json)
      VALUES ('github', ?, 'ping', ?, 'processing', ?, ?)
    `
    ).run(deliveryId, now.toISOString(), leaseExpiresAt, payload);

    const response = await fetch(`http://localhost:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("Webhook processed successfully");

    const delivery = db.prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = ?").get(deliveryId) as any;
    expect(delivery.status).toBe("processed");
    expect(delivery.attempt_count).toBe(1); // incremented by 1 during CAS update
  });

  it("should process webhook successfully using the backward compatibility alias path", async () => {
    const payload = JSON.stringify({ action: "ping" });
    const signature = calculateSignature(payload);
    const deliveryId = crypto.randomUUID();

    const response = await fetch(`http://localhost:${port}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "ping",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe("Webhook processed successfully");

    const delivery = db.prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = ?").get(deliveryId) as any;
    expect(delivery).not.toBeUndefined();
    expect(delivery.status).toBe("processed");
  });

  it("should process membership added webhook without payload role by relying on live role check", async () => {
    fakeGitHubClient.teamMembers.push({
      teamId: 888,
      githubUserId: 777,
      githubLogin: "test-user",
      role: "member",
    });

    const payload = JSON.stringify({
      action: "added",
      team: { id: 888 },
      member: { id: 777, login: "test-user" },
      organization: { id: 1111 },
    });
    const signature = calculateSignature(payload);
    const deliveryId = crypto.randomUUID();

    const response = await fetch(`http://localhost:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "membership",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    const audit = db.prepare("SELECT * FROM audit_events WHERE event_type = 'github.external_membership_added'").get() as any;
    expect(audit).not.toBeUndefined();
    expect(JSON.parse(audit.payload_json).observed_role).toBe("member");
  });

  it("should log mismatch when webhook added event is received but user is absent on live check", async () => {
    const payload = JSON.stringify({
      action: "added",
      team: { id: 888 },
      member: { id: 777, login: "test-user" },
      organization: { id: 1111 },
    });
    const signature = calculateSignature(payload);
    const deliveryId = crypto.randomUUID();

    const response = await fetch(`http://localhost:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "membership",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    const audit = db.prepare("SELECT * FROM audit_events WHERE event_type = 'github.membership_mismatch_detected'").get() as any;
    expect(audit).not.toBeUndefined();
    expect(JSON.parse(audit.payload_json).live_role).toBe("absent");
  });

  it("should update healthState.githubError on GitHub API permission error", async () => {
    fakeGitHubClient.simulateRateLimit = false;
    vi.spyOn(fakeGitHubClient, "getTeamMembership").mockRejectedValueOnce(
      new (await import("../../src/domain/errors.js")).GitHubUnauthorizedError("Bad credentials")
    );

    const payload = JSON.stringify({
      action: "added",
      team: { id: 888 },
      member: { id: 777, login: "test-user" },
      organization: { id: 1111 },
    });
    const signature = calculateSignature(payload);
    const deliveryId = crypto.randomUUID();

    const response = await fetch(`http://localhost:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "membership",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(500);
    const { healthState } = await import("../../src/http/health-routes.js");
    expect(healthState.githubError).toBe("Bad credentials");
  });

  it("should fail delivery and retry on transient GitHub API error", async () => {
    fakeGitHubClient.simulateTransientError = true;

    const payload = JSON.stringify({
      action: "added",
      team: { id: 888 },
      member: { id: 777, login: "test-user" },
      organization: { id: 1111 },
    });
    const signature = calculateSignature(payload);
    const deliveryId = crypto.randomUUID();

    const response = await fetch(`http://localhost:${port}/github/webhooks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": deliveryId,
        "x-github-event": "membership",
        "x-hub-signature-256": signature,
      },
      body: payload,
    });

    expect(response.status).toBe(500);
    const delivery = db.prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = ?").get(deliveryId) as any;
    expect(delivery.status).toBe("failed");
    expect(delivery.last_error).toContain("Transient error");
  });
});
