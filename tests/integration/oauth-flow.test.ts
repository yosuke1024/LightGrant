import { vi } from "vitest";

// Mock 'octokit' immediately before any other imports load
vi.mock("octokit", () => {
  const mockReq = vi.fn();
  (global as any).__mockRequest = mockReq;

  class MockApp {
    octokit = {
      request: mockReq,
    };
    getInstallationOctokit = vi.fn().mockResolvedValue({
      request: mockReq,
    });
  }

  class MockOctokit {
    request = mockReq;
  }

  return {
    App: MockApp,
    Octokit: MockOctokit,
  };
});

// Standard imports
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "../../src/http/server.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import { generateStateToken } from "../../src/security/signed-state.js";
import { OAuthStateRepository } from "../../src/persistence/repositories/oauth-state-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Server } from "http";
import { WebClient } from "@slack/web-api";
import { FakeGitHubClient } from "../fakes/fake-github-client.js";

describe("GitHub OAuth Flow Integration", () => {
  let server: Server;
  let baseUrl: string;
  const tempDbPath = path.resolve("./tests/oauth-flow-test.sqlite");
  let db: any;

  beforeAll(async () => {
    WebClient.prototype.apiCall = vi.fn().mockResolvedValue({ ok: true });
    closeDatabase();
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    process.env.DATABASE_PATH = tempDbPath;
    process.env.APP_SECRET = "a".repeat(32);
    process.env.PUBLIC_BASE_URL = "http://localhost";
    process.env.GITHUB_CLIENT_ID = "Iv1.test-client-id";
    process.env.GITHUB_CLIENT_SECRET = "test-client-secret";

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
        const address = server.address();
        if (address && typeof address !== "string") {
          baseUrl = `http://localhost:${address.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    closeDatabase();
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  beforeEach(() => {
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM identity_links").run();
    db.prepare("DELETE FROM oauth_states").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
    (global as any).__mockRequest.mockReset();
    vi.restoreAllMocks();
  });

  it("GET /auth/github/start should redirect on valid state", async () => {
    const expiresAt = Date.now() + 600000;
    const nonce = crypto.randomBytes(32).toString("hex");
    const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");

    const stateId = crypto.randomUUID();
    const oauthRepo = new OAuthStateRepository(db);
    oauthRepo.createState(
      stateId,
      nonceHash,
      "W123",
      "U456",
      "test",
      null,
      new Date(expiresAt).toISOString(),
      new Date().toISOString(),
    );

    const stateToken = generateStateToken("W123", "U456", nonce, expiresAt);

    // Mock resolveInstallation GET /orgs/{org}/installation
    (global as any).__mockRequest.mockResolvedValueOnce({
      data: {
        id: 98765,
        target_id: 1111,
        target_type: "Organization",
        account: { login: "test-org" },
      },
    });

    const res = await fetch(
      `${baseUrl}/auth/github/start?state=${stateToken}`,
      {
        redirect: "manual",
      },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toContain("https://github.com/login/oauth/authorize");
    expect(location).toContain("client_id=");
    expect(location).toContain(`state=${stateToken}`);
  });

  it("GET /auth/github/callback should exchange code and create link", async () => {
    const expiresAt = Date.now() + 600000;
    const nonce = crypto.randomBytes(32).toString("hex");
    const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");

    const stateId = crypto.randomUUID();
    const oauthRepo = new OAuthStateRepository(db);
    oauthRepo.createState(
      stateId,
      nonceHash,
      "W123",
      "U456",
      "test",
      null,
      new Date(expiresAt).toISOString(),
      new Date().toISOString(),
    );

    const stateToken = generateStateToken("W123", "U456", nonce, expiresAt);

    // Spy on global fetch, mock only GitHub token calls and pass-through others
    const originalFetch = global.fetch;
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : (input as any).url;
        if (url.includes("github.com/login/oauth/access_token")) {
          return {
            ok: true,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ access_token: "mock-user-token" }),
          } as any;
        }
        return originalFetch(input, init);
      });

    // Mock Octokit request for GET /user (called internally in getAuthenticatedUser)
    (global as any).__mockRequest.mockResolvedValueOnce({
      data: {
        id: 999,
        login: "octocat",
        name: "The Octocat",
        email: "octocat@github.com",
      },
    });

    const res = await fetch(
      `${baseUrl}/auth/github/callback?code=mock-code&state=${stateToken}`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("GitHub Account Connected Successfully!");

    // Verify identity link was written
    const identityRepo = new IdentityRepository(db);
    const link = identityRepo.getLinkBySlackUser("W123", "U456");
    expect(link).not.toBeNull();
    expect(link?.github_user_id).toBe(999);
    expect(link?.github_login).toBe("octocat");

    // Verify oauth state was marked used
    const stateAfter = oauthRepo.getState(stateId);
    expect(stateAfter?.used_at).not.toBeNull();

    // Replay attack: trying again should fail (400 Bad Request)
    const replayRes = await fetch(
      `${baseUrl}/auth/github/callback?code=mock-code&state=${stateToken}`,
    );
    expect(replayRes.status).toBe(400);
  });

  it("GET /auth/github/callback should handle OAuth link conflicts (Cases A-D)", async () => {
    const expiresAt = Date.now() + 600000;
    const identityRepo = new IdentityRepository(db);

    const originalFetch = global.fetch;
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockImplementation(async (input, init) => {
        const url = typeof input === "string" ? input : (input as any).url;
        if (url.includes("github.com/login/oauth/access_token")) {
          return {
            ok: true,
            headers: new Headers({ "content-type": "application/json" }),
            json: async () => ({ access_token: "mock-user-token" }),
          } as any;
        }
        return originalFetch(input, init);
      });

    // Helper to run a callback flow simulation
    const runCallback = async (
      slackWorkspaceId: string,
      slackUserId: string,
      githubUserId: number,
      githubLogin: string,
    ) => {
      const nonce = crypto.randomBytes(32).toString("hex");
      const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");
      const stateId = crypto.randomUUID();
      const oauthRepo = new OAuthStateRepository(db);
      oauthRepo.createState(
        stateId,
        nonceHash,
        slackWorkspaceId,
        slackUserId,
        "test",
        null,
        new Date(expiresAt).toISOString(),
        new Date().toISOString(),
      );
      const stateToken = generateStateToken(
        slackWorkspaceId,
        slackUserId,
        nonce,
        expiresAt,
      );

      (global as any).__mockRequest.mockResolvedValueOnce({
        data: {
          id: githubUserId,
          login: githubLogin,
          name: githubLogin,
          email: `${githubLogin}@github.com`,
        },
      });

      const res = await fetch(
        `${baseUrl}/auth/github/callback?code=mock-code&state=${stateToken}`,
      );
      return res;
    };

    // --- Case D: Fresh Link (Successful) ---
    // Slack: W-1, U-1 -> GitHub: GH-1
    const resD = await runCallback("W-1", "U-1", 1001, "gh-user-1");
    expect(resD.status).toBe(200);
    const linkD = identityRepo.getLinkBySlackUser("W-1", "U-1");
    expect(linkD).not.toBeNull();
    expect(linkD?.github_user_id).toBe(1001);

    // --- Case A: Re-verify Same Link (Successful update last_verified_at) ---
    // Slack: W-1, U-1 -> GitHub: GH-1 again
    const oldLastVerified = linkD?.last_verified_at;
    // Wait a tiny bit or simulate delay
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resA = await runCallback("W-1", "U-1", 1001, "gh-user-1");
    expect(resA.status).toBe(200);
    const linkA = identityRepo.getLinkBySlackUser("W-1", "U-1");
    expect(linkA?.last_verified_at).not.toBe(oldLastVerified); // Updated!

    // --- Case B: Slack User tries to link to a DIFFERENT GitHub User ---
    // Slack: W-1, U-1 is linked to GH-1. Trying to link W-1, U-1 to GH-2.
    const resB = await runCallback("W-1", "U-1", 1002, "gh-user-2");
    expect(resB.status).toBe(409); // Conflict
    const htmlB = await resB.text();
    expect(htmlB).toContain("Account Link Conflict");
    expect(htmlB).toContain("already linked to another GitHub account");

    // --- Case C: Different Slack User tries to link to an ALREADY LINKED GitHub User ---
    // Slack: W-1, U-2 tries to link to GH-1 (which is already linked to W-1, U-1).
    const resC = await runCallback("W-1", "U-2", 1001, "gh-user-1");
    expect(resC.status).toBe(409); // Conflict
    const htmlC = await resC.text();
    expect(htmlC).toContain("Account Link Conflict");
    expect(htmlC).toContain("already linked to another Slack user");
  });
});
