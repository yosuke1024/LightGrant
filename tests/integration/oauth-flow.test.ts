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
import { config } from "../../src/config.js";
import { OAuthStateRepository } from "../../src/persistence/repositories/oauth-state-repository.js";
import { IdentityRepository } from "../../src/persistence/repositories/identity-repository.js";
import { hashOidcValue } from "../../src/security/slack-oidc.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Server } from "http";
import { WebClient } from "@slack/web-api";
import { FakeGitHubClient } from "../fakes/fake-github-client.js";

/**
 * Build a Slack OIDC id_token for the fake token endpoint. A real Slack ID
 * Token is an RS256-signed JWT; the app relies on the server-to-server TLS
 * channel of the token exchange for authenticity (OpenID Connect Core
 * §3.1.3.7) rather than verifying the signature itself, so it only decodes and
 * validates the claims. This fake therefore carries a placeholder signature
 * segment — the app never inspects it — but a fully valid claim set.
 */
function buildSlackIdToken(opts: {
  teamId: string;
  userId: string;
  nonce: string | null;
  aud?: string;
  iss?: string;
  expOffsetSeconds?: number;
}): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const claims: Record<string, unknown> = {
    iss: opts.iss ?? "https://slack.com",
    aud: opts.aud ?? config.SLACK_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + (opts.expOffsetSeconds ?? 300),
    "https://slack.com/team_id": opts.teamId,
    "https://slack.com/user_id": opts.userId,
  };
  if (opts.nonce !== null) {
    claims.nonce = opts.nonce;
  }
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

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

  /** Seed an unused OAuth state row and return its signed state token. */
  function seedState(workspaceId: string, userId: string): string {
    const expiresAt = Date.now() + 600000;
    const nonce = crypto.randomBytes(32).toString("hex");
    const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");
    const oauthRepo = new OAuthStateRepository(db);
    oauthRepo.createState(
      crypto.randomUUID(),
      nonceHash,
      workspaceId,
      userId,
      "test",
      null,
      new Date(expiresAt).toISOString(),
      new Date().toISOString(),
    );
    return generateStateToken(workspaceId, userId, nonce, expiresAt);
  }

  /** Mock global.fetch for the Slack + GitHub token endpoints. */
  function mockTokenEndpoints(idTokenFor: (state: string) => string) {
    const originalFetch = global.fetch;
    return vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("openid.connect.token")) {
        const body = String((init as any)?.body ?? "");
        const state = new URLSearchParams(body).get("code") ?? "";
        return {
          ok: true,
          json: async () => ({ ok: true, id_token: idTokenFor(state) }),
        } as any;
      }
      if (url.includes("github.com/login/oauth/access_token")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ access_token: "mock-user-token" }),
        } as any;
      }
      return originalFetch(input, init);
    });
  }

  it("GET /auth/github/start should redirect to Sign in with Slack", async () => {
    const stateToken = seedState("W123", "U456");

    const res = await fetch(
      `${baseUrl}/auth/github/start?state=${stateToken}`,
      {
        redirect: "manual",
      },
    );

    expect(res.status).toBe(302);
    const location = res.headers.get("location")!;
    expect(location).toContain("https://slack.com/openid/connect/authorize");
    expect(location).toContain("scope=openid");
    const parsed = new URL(location);
    expect(parsed.searchParams.get("state")).toBe(stateToken);
    expect(parsed.searchParams.get("team")).toBe("W123");
    expect(parsed.searchParams.get("nonce")).toBeTruthy();
  });

  /**
   * Drive the full happy path: start -> Slack OIDC callback -> GitHub callback,
   * carrying the browser-binding cookie the way a real browser would.
   */
  async function driveFullFlow(
    workspaceId: string,
    userId: string,
    githubUserId: number,
    githubLogin: string,
    slackIdentity?: { teamId: string; userId: string },
  ) {
    const stateToken = seedState(workspaceId, userId);

    // 1. start -> capture the OIDC nonce Slack would echo back.
    const startRes = await fetch(
      `${baseUrl}/auth/github/start?state=${stateToken}`,
      { redirect: "manual" },
    );
    const authorizeUrl = new URL(startRes.headers.get("location")!);
    const oidcNonce = authorizeUrl.searchParams.get("nonce")!;

    const verifiedIdentity = slackIdentity ?? { teamId: workspaceId, userId };
    mockTokenEndpoints(() =>
      buildSlackIdToken({
        teamId: verifiedIdentity.teamId,
        userId: verifiedIdentity.userId,
        nonce: oidcNonce,
      }),
    );

    // 2. Slack OIDC callback -> issues binding cookie, redirects to GitHub.
    const slackRes = await fetch(
      `${baseUrl}/auth/slack/callback?code=slack-code&state=${stateToken}`,
      { redirect: "manual" },
    );

    return { stateToken, slackRes, githubUserId, githubLogin };
  }

  /** Extract the lg_bind cookie value from a Set-Cookie header, if any. */
  function bindingCookie(setCookie: string | null): string | null {
    if (!setCookie) return null;
    const match = setCookie.match(/lg_bind=([^;]*)/);
    return match ? match[1] : null;
  }

  it("full flow: start -> Slack OIDC -> GitHub callback creates the link", async () => {
    const { stateToken, slackRes, githubUserId, githubLogin } =
      await driveFullFlow("W123", "U456", 999, "octocat");

    expect(slackRes.status).toBe(302);
    expect(slackRes.headers.get("location")).toContain(
      "https://github.com/login/oauth/authorize",
    );
    const cookie = bindingCookie(slackRes.headers.get("set-cookie"));
    expect(cookie).toBeTruthy();

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
      { headers: { cookie: `lg_bind=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(
      "GitHub Account Connected Successfully!",
    );

    const identityRepo = new IdentityRepository(db);
    const link = identityRepo.getLinkBySlackUser("W123", "U456");
    expect(link?.github_user_id).toBe(999);
    expect(link?.github_login).toBe("octocat");

    // Replay: the state is consumed and the cookie is one-time -> 400.
    const replay = await fetch(
      `${baseUrl}/auth/github/callback?code=mock-code&state=${stateToken}`,
      { headers: { cookie: `lg_bind=${cookie}` } },
    );
    expect(replay.status).toBe(400);
  });

  it("Slack OIDC callback rejects a mismatched Slack identity (takeover attempt)", async () => {
    // State was started for U456, but the browser signs in to Slack as U_ATTACKER.
    const { slackRes } = await driveFullFlow("W123", "U456", 999, "octocat", {
      teamId: "W123",
      userId: "U_ATTACKER",
    });

    expect(slackRes.status).toBe(403);
    expect(await slackRes.text()).toContain("Verification Failed");
    // No binding cookie is issued to a mismatched browser.
    expect(bindingCookie(slackRes.headers.get("set-cookie"))).toBeFalsy();
  });

  it("GitHub callback refuses a browser that lacks the binding cookie", async () => {
    const { stateToken, slackRes } = await driveFullFlow(
      "W123",
      "U456",
      999,
      "octocat",
    );
    expect(slackRes.status).toBe(302);

    // A victim who opened a forwarded GitHub-authorize URL carries no cookie.
    const res = await fetch(
      `${baseUrl}/auth/github/callback?code=mock-code&state=${stateToken}`,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("Verification Failed");

    // The link must NOT have been created.
    const identityRepo = new IdentityRepository(db);
    expect(identityRepo.getLinkBySlackUser("W123", "U456")).toBeNull();
  });

  it("GitHub callback refuses a state that skipped the Slack leg", async () => {
    // Seed a state and go straight to the GitHub callback (no Slack OIDC).
    const stateToken = seedState("W123", "U456");
    const res = await fetch(
      `${baseUrl}/auth/github/callback?code=mock-code&state=${stateToken}`,
    );
    expect(res.status).toBe(403);
  });

  it("Slack callback fails closed when the state never started (no OIDC nonce)", async () => {
    // A state that skipped /auth/github/start has oidc_nonce_hash = NULL. Even
    // with a perfectly matching Slack identity, nonce verification must not be
    // bypassed.
    const stateToken = seedState("W123", "U456");
    mockTokenEndpoints(() =>
      buildSlackIdToken({ teamId: "W123", userId: "U456", nonce: "whatever" }),
    );

    const res = await fetch(
      `${baseUrl}/auth/slack/callback?code=slack-code&state=${stateToken}`,
      { redirect: "manual" },
    );

    expect(res.status).not.toBe(302);
    expect(bindingCookie(res.headers.get("set-cookie"))).toBeFalsy();
    const row = db
      .prepare("SELECT slack_verified_at, binding_token_hash FROM oauth_states")
      .get();
    expect(row.slack_verified_at).toBeNull();
    expect(row.binding_token_hash).toBeNull();
  });

  it("Slack callback rejects an id_token whose nonce does not match the flow", async () => {
    const stateToken = seedState("W123", "U456");
    // Complete /auth/github/start so a nonce is recorded for this flow.
    await fetch(`${baseUrl}/auth/github/start?state=${stateToken}`, {
      redirect: "manual",
    });
    // Return an id_token carrying a DIFFERENT (stale/attacker) nonce.
    mockTokenEndpoints(() =>
      buildSlackIdToken({
        teamId: "W123",
        userId: "U456",
        nonce: "stale-nonce-not-ours",
      }),
    );

    const res = await fetch(
      `${baseUrl}/auth/slack/callback?code=slack-code&state=${stateToken}`,
      { redirect: "manual" },
    );

    expect(res.status).not.toBe(302);
    expect(bindingCookie(res.headers.get("set-cookie"))).toBeFalsy();
    expect(
      db.prepare("SELECT slack_verified_at FROM oauth_states").get()
        .slack_verified_at,
    ).toBeNull();
  });

  it("Slack callback rejects an id_token that is missing its nonce", async () => {
    const stateToken = seedState("W123", "U456");
    await fetch(`${baseUrl}/auth/github/start?state=${stateToken}`, {
      redirect: "manual",
    });
    mockTokenEndpoints(() =>
      buildSlackIdToken({ teamId: "W123", userId: "U456", nonce: null }),
    );

    const res = await fetch(
      `${baseUrl}/auth/slack/callback?code=slack-code&state=${stateToken}`,
      { redirect: "manual" },
    );

    expect(res.status).not.toBe(302);
    expect(
      db.prepare("SELECT slack_verified_at FROM oauth_states").get()
        .slack_verified_at,
    ).toBeNull();
  });

  it("running /auth/github/start twice does not overwrite the OIDC nonce", async () => {
    const stateToken = seedState("W123", "U456");

    const first = await fetch(
      `${baseUrl}/auth/github/start?state=${stateToken}`,
      { redirect: "manual" },
    );
    expect(first.status).toBe(302);
    const firstNonce = new URL(first.headers.get("location")!).searchParams.get(
      "nonce",
    )!;

    // A second start must not mint and store a new nonce over the pending one.
    const second = await fetch(
      `${baseUrl}/auth/github/start?state=${stateToken}`,
      { redirect: "manual" },
    );
    expect(second.status).not.toBe(302);

    const storedHash = db
      .prepare("SELECT oidc_nonce_hash FROM oauth_states")
      .get().oidc_nonce_hash;
    expect(storedHash).toBe(hashOidcValue(firstNonce));
  });

  it("GitHub callback consumes a verified state at most once under concurrency", async () => {
    const { stateToken, slackRes } = await driveFullFlow(
      "W123",
      "U456",
      999,
      "octocat",
    );
    const cookie = bindingCookie(slackRes.headers.get("set-cookie"))!;

    // Barrier so the winning callback parks INSIDE the GitHub token exchange
    // while the second callback runs. This forces genuine overlap rather than
    // relying on accidental sequential execution.
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let githubTokenCalls = 0;
    const originalFetch = global.fetch;
    vi.spyOn(global, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : (input as any).url;
      if (url.includes("github.com/login/oauth/access_token")) {
        githubTokenCalls++;
        await barrier;
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ access_token: "mock-user-token" }),
        } as any;
      }
      return originalFetch(input, init);
    });
    (global as any).__mockRequest.mockResolvedValue({
      data: { id: 999, login: "octocat", name: "octocat", email: "o@x.com" },
    });

    const p1 = fetch(
      `${baseUrl}/auth/github/callback?code=code-1&state=${stateToken}`,
      { headers: { cookie: `lg_bind=${cookie}` } },
    );
    const p2 = fetch(
      `${baseUrl}/auth/github/callback?code=code-2&state=${stateToken}`,
      { headers: { cookie: `lg_bind=${cookie}` } },
    );

    // The loser is refused before any GitHub call, so it settles while the
    // winner is still parked on the barrier. Wait for that first settlement
    // (deterministic — no fixed sleep) before releasing the winner.
    await Promise.race([p1, p2]);
    release();

    const [r1, r2] = await Promise.all([p1, p2]);
    const statuses = [r1.status, r2.status];
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.some((s) => s === 400 || s === 409)).toBe(true);

    // The GitHub token endpoint — and therefore the link/audit/resume work —
    // must run at most once.
    expect(githubTokenCalls).toBe(1);
    const linkCount = db
      .prepare(
        "SELECT COUNT(*) AS n FROM identity_links WHERE slack_user_id = 'U456'",
      )
      .get().n;
    expect(linkCount).toBe(1);
  });

  it("GET /auth/github/callback should handle OAuth link conflicts (Cases A-D)", async () => {
    const identityRepo = new IdentityRepository(db);

    // Runs the full binding flow and then the GitHub callback with the cookie.
    const runCallback = async (
      workspaceId: string,
      userId: string,
      githubUserId: number,
      githubLogin: string,
    ) => {
      const { stateToken, slackRes } = await driveFullFlow(
        workspaceId,
        userId,
        githubUserId,
        githubLogin,
      );
      const cookie = bindingCookie(slackRes.headers.get("set-cookie"));

      (global as any).__mockRequest.mockResolvedValueOnce({
        data: {
          id: githubUserId,
          login: githubLogin,
          name: githubLogin,
          email: `${githubLogin}@github.com`,
        },
      });

      return fetch(
        `${baseUrl}/auth/github/callback?code=mock-code&state=${stateToken}`,
        { headers: { cookie: `lg_bind=${cookie}` } },
      );
    };

    // --- Case D: Fresh Link (Successful) ---
    const resD = await runCallback("W-1", "U-1", 1001, "gh-user-1");
    expect(resD.status).toBe(200);
    const linkD = identityRepo.getLinkBySlackUser("W-1", "U-1");
    expect(linkD?.github_user_id).toBe(1001);

    // --- Case A: Re-verify Same Link (Successful update last_verified_at) ---
    const oldLastVerified = linkD?.last_verified_at;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const resA = await runCallback("W-1", "U-1", 1001, "gh-user-1");
    expect(resA.status).toBe(200);
    const linkA = identityRepo.getLinkBySlackUser("W-1", "U-1");
    expect(linkA?.last_verified_at).not.toBe(oldLastVerified);

    // --- Case B: Slack User tries to link to a DIFFERENT GitHub User ---
    const resB = await runCallback("W-1", "U-1", 1002, "gh-user-2");
    expect(resB.status).toBe(409);
    expect(await resB.text()).toContain(
      "already linked to another GitHub account",
    );

    // --- Case C: Different Slack User tries to link to an ALREADY LINKED GitHub User ---
    const resC = await runCallback("W-1", "U-2", 1001, "gh-user-1");
    expect(resC.status).toBe(409);
    expect(await resC.text()).toContain("already linked to another Slack user");
  });
});
