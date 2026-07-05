import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import crypto from "crypto";
import { runMigrations } from "../../src/persistence/migrations.js";
import { WebhookService } from "../../src/services/webhook-service.js";
import { GrantRepository } from "../../src/persistence/repositories/grant-repository.js";
import { FakeGitHubClient } from "../fakes/fake-github-client.js";

describe("WebhookService & Drift", () => {
  const tempDbPath = "./tests/webhook-service-test.sqlite";
  let db: Database.Database;
  let grantRepo: GrantRepository;
  let fakeGitHubClient: FakeGitHubClient;
  const orgContext = { organizationId: 1111 };

  beforeAll(() => {
    db = new Database(tempDbPath);
    runMigrations(db);
    grantRepo = new GrantRepository(db);
    fakeGitHubClient = new FakeGitHubClient();
  });

  afterAll(() => {
    if (db) db.close();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM webhook_deliveries").run();
    db.prepare("DELETE FROM grants").run();
    db.prepare("DELETE FROM audit_events").run();
    if (fakeGitHubClient) {
      fakeGitHubClient.teamMembers = [];
      fakeGitHubClient.calls = [];
    }
  });

  it("should process membership removed webhook and mark active grant as revoked (Drift)", async () => {
    const timestamp = new Date().toISOString();
    
    // Seed active grant
    grantRepo.createGrant({
      id: "grant-test-remove",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: null,
      grantedAt: timestamp,
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const payload = {
      action: "removed",
      team: { id: 2222 },
      member: { id: 999, login: "octocat" },
      organization: { id: 1111 },
    };

    const service = new WebhookService(db, orgContext as any, fakeGitHubClient);
    const deliveryId = "del-remove-123";

    // Register delivery as received
    db.prepare(
      "INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, payload_json) VALUES ('github', ?, 'membership', ?, 'received', ?)"
    ).run(deliveryId, timestamp, JSON.stringify(payload));

    const result = await service.processDelivery(deliveryId, "membership", payload);
    expect(result).toBe(true);

    // Verify DB updated
    const updated = grantRepo.getGrant("grant-test-remove")!;
    expect(updated.status).toBe("revoked");
    expect(updated.last_error_code).toBe("manually_removed_from_github");

    // Verify webhook status
    const delivery = db.prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = ?").get(deliveryId) as any;
    expect(delivery.status).toBe("processed");

    // Verify audit event
    const audit = db.prepare("SELECT * FROM audit_events WHERE event_type = 'grant.drift_detected'").all();
    expect(audit.length).toBe(1);
  });

  it("should process membership added webhook and NOT register preexisting grant when no active grant exists (Drift)", async () => {
    const timestamp = new Date().toISOString();
    const payload = {
      action: "added",
      team: { id: 2222 },
      member: { id: 999, login: "octocat" },
      organization: { id: 1111 },
      role: "member",
    };

    fakeGitHubClient.teamMembers.push({
      teamId: 2222,
      githubUserId: 999,
      githubLogin: "octocat",
      role: "member",
    });

    const service = new WebhookService(db, orgContext as any, fakeGitHubClient);
    const deliveryId = "del-add-123";

    db.prepare(
      "INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, payload_json) VALUES ('github', ?, 'membership', ?, 'received', ?)"
    ).run(deliveryId, timestamp, JSON.stringify(payload));

    const result = await service.processDelivery(deliveryId, "membership", payload);
    expect(result).toBe(true);

    // Verify NO preexisting grant created
    const grants = db.prepare("SELECT * FROM grants WHERE github_user_id = ? AND target_team_id = ?").all(999, 2222) as any[];
    expect(grants.length).toBe(0);

    const audit = db.prepare("SELECT * FROM audit_events WHERE event_type = 'github.external_membership_added'").all();
    expect(audit.length).toBe(1);
  });

  it("should handle membership elevation to maintainer (Drift)", async () => {
    const timestamp = new Date().toISOString();

    grantRepo.createGrant({
      id: "grant-test-elevate",
      githubOrgId: 1111,
      targetTeamId: 2222,
      githubUserId: 999,
      githubLoginSnapshot: "octocat",
      status: "active",
      membershipCreatedByApp: 1,
      preexistingRole: "member",
      grantedAt: timestamp,
      effectiveExpiresAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const payload = {
      action: "added",
      team: { id: 2222 },
      member: { id: 999, login: "octocat" },
      organization: { id: 1111 },
      role: "maintainer",
    };

    fakeGitHubClient.teamMembers.push({
      teamId: 2222,
      githubUserId: 999,
      githubLogin: "octocat",
      role: "maintainer",
    });

    const service = new WebhookService(db, orgContext as any, fakeGitHubClient);
    const deliveryId = "del-elevate-123";

    db.prepare(
      "INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, payload_json) VALUES ('github', ?, 'membership', ?, 'received', ?)"
    ).run(deliveryId, timestamp, JSON.stringify(payload));

    const result = await service.processDelivery(deliveryId, "membership", payload);
    expect(result).toBe(true);

    const updated = grantRepo.getGrant("grant-test-elevate")!;
    expect(updated.status).toBe("active");
    expect(updated.last_error_code).toBe("membership_elevated");
  });

  it("should handle demotion of maintainer back to member (Drift)", async () => {
    const timestamp = new Date().toISOString();

    // Seed grant currently marked as elevated maintainer
    db.prepare(
      `
      INSERT INTO grants (
        id, github_org_id, target_team_id, github_user_id, github_login_snapshot,
        status, membership_created_by_app, preexisting_role, granted_at, effective_expires_at,
        created_at, updated_at, last_error_code
      ) VALUES ('grant-test-demote', 1111, 2222, 999, 'octocat', 'active', 1, 'member', ?, ?, ?, ?, 'membership_elevated')
      `
    ).run(timestamp, timestamp, timestamp, timestamp);

    const payload = {
      action: "added",
      team: { id: 2222 },
      member: { id: 999, login: "octocat" },
      organization: { id: 1111 },
      role: "member",
    };

    fakeGitHubClient.teamMembers.push({
      teamId: 2222,
      githubUserId: 999,
      githubLogin: "octocat",
      role: "member",
    });

    const service = new WebhookService(db, orgContext as any, fakeGitHubClient);
    const deliveryId = "del-demote-123";

    db.prepare(
      "INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, payload_json) VALUES ('github', ?, 'membership', ?, 'received', ?)"
    ).run(deliveryId, timestamp, JSON.stringify(payload));

    const result = await service.processDelivery(deliveryId, "membership", payload);
    expect(result).toBe(true);

    const updated = grantRepo.getGrant("grant-test-demote")!;
    expect(updated.status).toBe("active");
    expect(updated.last_error_code).toBeNull();
  });

  it("should reprocess failed deliveries successfully", async () => {
    const timestamp = new Date().toISOString();
    const payload = {
      action: "added",
      team: { id: 2222 },
      member: { id: 999, login: "octocat" },
      organization: { id: 1111 },
      role: "member",
    };

    // Store a failed delivery
    db.prepare(
      `
      INSERT INTO webhook_deliveries (provider, delivery_id, event_name, received_at, status, payload_json)
      VALUES ('github', 'del-fail-123', 'membership', ?, 'failed', ?)
      `
    ).run(timestamp, JSON.stringify(payload));

    fakeGitHubClient.teamMembers.push({
      teamId: 2222,
      githubUserId: 999,
      githubLogin: "octocat",
      role: "member",
    });

    const service = new WebhookService(db, orgContext as any, fakeGitHubClient);
    const count = await service.reprocessAllFailedDeliveries();
    expect(count).toBe(1);

    const delivery = db.prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = 'del-fail-123'").get() as any;
    expect(delivery.status).toBe("processed");
  });
});
