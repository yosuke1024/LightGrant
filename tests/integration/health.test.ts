import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { createServer } from "../../src/http/server.js";
import { healthState } from "../../src/http/health-routes.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import { Server } from "http";
import { WebClient } from "@slack/web-api";
import { FakeGitHubClient } from "../fakes/fake-github-client.js";
import fs from "fs";
import path from "path";

describe("Health and Readiness HTTP Endpoints", () => {
  let server: Server;
  let baseUrl: string;
  const tempDbPath = path.resolve("./tests/health-test.sqlite");

  beforeAll(async () => {
    WebClient.prototype.apiCall = vi.fn().mockResolvedValue({ ok: true });
    // Configure environment for the test database
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    process.env.DATABASE_PATH = tempDbPath;
    process.env.PUBLIC_BASE_URL = "http://localhost";
    process.env.APP_SECRET = "a".repeat(32);
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    process.env.SLACK_SIGNING_SECRET = "test";
    process.env.SLACK_APPROVAL_CHANNEL_ID = "test";
    process.env.SLACK_AUDIT_CHANNEL_ID = "test";
    process.env.GITHUB_ORG = "test";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_CLIENT_ID = "Iv1.test";
    process.env.GITHUB_CLIENT_SECRET = "test";
    process.env.GITHUB_PRIVATE_KEY_BASE64 = Buffer.from(
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
    ).toString("base64");
    process.env.GITHUB_WEBHOOK_SECRET = "test";

    // Set up database and run migrations for integration health test
    const db = getDatabase();
    runMigrations(db);

    const mockOrgContext = {
      organizationId: 1111,
      organizationLogin: "test-org",
      installationId: 12345,
    };
    const app = createServer(mockOrgContext, new FakeGitHubClient());

    // Listen on dynamic port
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (address && typeof address !== "string") {
          baseUrl = `http://localhost:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    // Close connections and clean up file
    closeDatabase();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  beforeEach(() => {
    // Reset states
    healthState.isDatabaseReady = false;
    healthState.isMigrationsReady = false;
    healthState.isWorkersReady = false;
  });

  it("GET /healthz should return 200 OK", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "OK" });
  });

  it("GET /readyz should return 503 when not fully initialized", async () => {
    healthState.isMigrationsReady = false;
    healthState.isWorkersReady = true;

    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("NOT_READY");
    expect(body.checks.database).toBe(true);
    expect(body.checks.migrations).toBe(false);
    expect(body.checks.workers).toBe(true);
  });

  it("GET /readyz should return 200 when fully initialized", async () => {
    healthState.isMigrationsReady = true;
    healthState.isWorkersReady = true;

    const res = await fetch(`${baseUrl}/readyz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("READY");
    expect(body.checks.database).toBe(true);
    expect(body.checks.migrations).toBe(true);
    expect(body.checks.workers).toBe(true);
  });
});
