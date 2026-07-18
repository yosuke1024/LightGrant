import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackOidcCode,
  hashOidcValue,
} from "../../src/security/slack-oidc.js";
import { config } from "../../src/config.js";
import crypto from "crypto";

function idToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.sig`;
}

function baseClaims(overrides: Record<string, unknown> = {}) {
  return {
    iss: "https://slack.com",
    aud: config.SLACK_CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 300,
    "https://slack.com/team_id": "T123",
    "https://slack.com/user_id": "U123",
    nonce: "abc",
    ...overrides,
  };
}

function mockTokenResponse(body: Record<string, unknown>, ok = true) {
  return vi.spyOn(global, "fetch").mockResolvedValue({
    ok,
    json: async () => body,
  } as any);
}

describe("slack-oidc", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("buildSlackAuthorizeUrl encodes the required OIDC params", () => {
    const url = new URL(
      buildSlackAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://app.example.com/auth/slack/callback",
        state: "signed.state",
        nonce: "n0nce",
        teamId: "T999",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/openid/connect/authorize",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://app.example.com/auth/slack/callback",
    );
    expect(url.searchParams.get("state")).toBe("signed.state");
    expect(url.searchParams.get("nonce")).toBe("n0nce");
    expect(url.searchParams.get("team")).toBe("T999");
  });

  it("hashOidcValue is a stable sha256 hex digest", () => {
    const expected = crypto.createHash("sha256").update("hello").digest("hex");
    expect(hashOidcValue("hello")).toBe(expected);
  });

  it("exchangeSlackOidcCode returns team/user/nonce from a valid id_token", async () => {
    mockTokenResponse({ ok: true, id_token: idToken(baseClaims()) });
    const identity = await exchangeSlackOidcCode("code", "https://cb");
    expect(identity).toEqual({ teamId: "T123", userId: "U123", nonce: "abc" });
  });

  it("rejects an id_token with the wrong audience", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(baseClaims({ aud: "someone-else" })),
    });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /audience/,
    );
  });

  it("rejects an id_token with the wrong issuer", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(baseClaims({ iss: "https://evil.example.com" })),
    });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /issuer/,
    );
  });

  it("rejects an expired id_token", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(
        baseClaims({ exp: Math.floor(Date.now() / 1000) - 10 }),
      ),
    });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /expired/,
    );
  });

  it("rejects a Slack token error response", async () => {
    mockTokenResponse({ ok: false, error: "invalid_code" });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /invalid_code/,
    );
  });

  it("rejects when team_id / user_id claims are missing", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(baseClaims({ "https://slack.com/team_id": undefined })),
    });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /team_id/,
    );
  });

  it("rejects an id_token whose exp claim is missing", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(baseClaims({ exp: undefined })),
    });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /exp/,
    );
  });

  it("rejects an id_token whose exp claim is not a number", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(baseClaims({ exp: "soon" })),
    });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /exp/,
    );
  });

  it("rejects an id_token whose nonce claim is missing", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(baseClaims({ nonce: undefined })),
    });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /nonce/,
    );
  });

  it("rejects an id_token whose nonce claim is empty", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(baseClaims({ nonce: "" })),
    });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /nonce/,
    );
  });

  it("rejects a malformed JWT that is not three segments", async () => {
    mockTokenResponse({ ok: true, id_token: "not.a-jwt" });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /Malformed/,
    );
  });

  it("accepts a single-element aud array", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(baseClaims({ aud: [config.SLACK_CLIENT_ID] })),
    });
    const identity = await exchangeSlackOidcCode("code", "https://cb");
    expect(identity.userId).toBe("U123");
  });

  it("rejects a multi-audience id_token without a matching azp", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(
        baseClaims({ aud: [config.SLACK_CLIENT_ID, "another-app"] }),
      ),
    });
    await expect(exchangeSlackOidcCode("code", "https://cb")).rejects.toThrow(
      /audience/,
    );
  });

  it("accepts a multi-audience id_token when azp binds our client", async () => {
    mockTokenResponse({
      ok: true,
      id_token: idToken(
        baseClaims({
          aud: [config.SLACK_CLIENT_ID, "another-app"],
          azp: config.SLACK_CLIENT_ID,
        }),
      ),
    });
    const identity = await exchangeSlackOidcCode("code", "https://cb");
    expect(identity.userId).toBe("U123");
  });
});
