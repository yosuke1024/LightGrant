import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { runMigrations } from "../../src/persistence/migrations.js";
import { createServer } from "../../src/http/server.js";
import http from "http";
import crypto from "crypto";
import { WebClient } from "@slack/web-api";
import { getDatabase } from "../../src/persistence/database.js";
import { FakeGitHubClient } from "../fakes/fake-github-client.js";

describe("Setup Screen Integration", () => {
  const tempDbPath = path.resolve("./tests/setup-screen-test.sqlite");
  let db: Database.Database;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    WebClient.prototype.apiCall = vi.fn().mockResolvedValue({ ok: true });

    db = getDatabase();
    runMigrations(db);

    const mockOrgContext = {
      organizationId: 1111,
      organizationLogin: "test-org",
      installationId: 12345,
    };
    const app = createServer(mockOrgContext, new FakeGitHubClient());
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
  });

  it("should render setup status page successfully with valid token", async () => {
    const response = await fetch(
      `http://localhost:${port}/setup?setup_token=test-setup-token-at-least-32-chars-long`,
    );
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toContain("LightGrant Setup Status");
    expect(text).toContain("SQLite Database");
    expect(text).toContain("GitHub Integration");
    expect(text).toContain("Slack Bot");
    expect(text).toContain("Audit Chain Integrity");
    expect(text).toContain("Database Backup Export");
  });

  it("should reject unauthorized setup access with 401", async () => {
    // 1. Without token
    const res1 = await fetch(`http://localhost:${port}/setup`);
    expect(res1.status).toBe(401);

    // 2. Invalid token
    const res2 = await fetch(
      `http://localhost:${port}/setup?setup_token=wrong-token`,
    );
    expect(res2.status).toBe(401);

    // 3. Manifest without token
    const res3 = await fetch(
      `http://localhost:${port}/setup/slack-manifest.yaml`,
    );
    expect(res3.status).toBe(401);
  });

  it("should allow lease-based DB download, blocking re-use, expired, or invalid paths", async () => {
    // 1. Generate export token (lease)
    const exportRes = await fetch(
      `http://localhost:${port}/setup/export?setup_token=test-setup-token-at-least-32-chars-long`,
      {
        method: "POST",
      },
    );
    expect(exportRes.status).toBe(200);
    const data = await exportRes.json();
    expect(data.downloadUrl).toContain("/setup/download?token=");

    const downloadUrl = `http://localhost:${port}${data.downloadUrl}&setup_token=test-setup-token-at-least-32-chars-long`;

    // 2. Perform download successfully
    const downloadRes = await fetch(downloadUrl);
    expect(downloadRes.status).toBe(200);
    const blob = await downloadRes.blob();
    expect(blob.size).toBeGreaterThan(0);

    // 3. Attempt to download again (Re-use prevention)
    const repeatRes = await fetch(downloadUrl);
    expect(repeatRes.status).toBe(403);
    expect(await repeatRes.text()).toContain(
      "Lease token has already been used",
    );

    // 4. Test Path Traversal prevention
    // Insert a malicious token entry into DB directly
    const maliciousToken = "malicious-lease-token-" + crypto.randomUUID();
    const maliciousHash = crypto
      .createHash("sha256")
      .update(maliciousToken)
      .digest("hex");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();

    db.prepare(
      `
      INSERT INTO export_tokens (
        token_hash, slack_workspace_id, slack_user_id, file_path, expires_at, created_at, download_lease_expires_at
      ) VALUES (?, 'system', 'admin', ?, ?, ?, NULL)
    `,
    ).run(
      maliciousHash,
      "/etc/passwd",
      expiresAt,
      now.toISOString(),
    );

    const maliciousDownloadUrl = `http://localhost:${port}/setup/download?token=${maliciousToken}&setup_token=test-setup-token-at-least-32-chars-long`;
    const traversalRes = await fetch(maliciousDownloadUrl);
    if (traversalRes.status !== 400) {
      throw new Error(
        `Expected 400 but got ${traversalRes.status}. Text: ` +
          (await traversalRes.text()),
      );
    }
    expect(traversalRes.status).toBe(400);
    expect(await traversalRes.text()).toContain(
      "Access denied: Invalid database path",
    );
  });

  it("should return github-manifest.json successfully with valid token and verify it lacks secret", async () => {
    const response = await fetch(
      `http://localhost:${port}/setup/github-manifest.json?setup_token=test-setup-token-at-least-32-chars-long`,
    );
    expect(response.status).toBe(200);
    const json = await response.json() as any;
    expect(json.name).toBe("LightGrant");
    expect(json.hook_attributes.url).toContain("/github/webhooks");
    expect(json.client_secret).toBeUndefined();
  });

  it("should return slack-manifest.yaml with valid bot_user and oauth_config settings but without github callbacks", async () => {
    const response = await fetch(
      `http://localhost:${port}/setup/slack-manifest.yaml?setup_token=test-setup-token-at-least-32-chars-long`,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("oauth_config");
    expect(text).toContain("bot_user");
    expect(text).toContain("commands");
    expect(text).toContain("chat:write");
    expect(text).not.toContain("oauth/callback");
    expect(text).not.toContain("auth/github/callback");
  });

  it("should display setup integration endpoints in html", async () => {
    const response = await fetch(
      `http://localhost:${port}/setup?setup_token=test-setup-token-at-least-32-chars-long`,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Integration & Manifest Endpoints");
    expect(text).toContain("Slack Request (Events) URL");
    expect(text).toContain("GitHub OAuth Callback URL");
    expect(text).toContain("GitHub Webhook URL");
    expect(text).toContain("GitHub App Manifest Configuration URL");
    expect(text).toContain("Slack App Manifest YAML URL");
  });
});
