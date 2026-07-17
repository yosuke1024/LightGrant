import crypto from "crypto";
import { config } from "../config.js";

/**
 * "Sign in with Slack" (OpenID Connect) helper.
 *
 * Used to prove that the browser driving the GitHub OAuth link belongs to the
 * Slack user recorded in the signed state. Mirrors the raw-fetch style of the
 * GitHub token exchange in github-oauth-routes.ts (tests mock global.fetch)
 * rather than introducing a new adapter, keeping the two OAuth legs uniform.
 */

const SLACK_ISSUER = "https://slack.com";
const SLACK_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/openid.connect.token";

export interface SlackOidcIdentity {
  /** Slack workspace/team id (the `https://slack.com/team_id` claim). */
  teamId: string;
  /** Slack user id (the `https://slack.com/user_id` claim). */
  userId: string;
  /** The `nonce` claim echoed back from the authorize request, if present. */
  nonce: string | null;
}

/**
 * Build the Slack OIDC authorize URL. `openid` is the only scope required to
 * learn the signed-in user's team_id / user_id. `team` pins the workspace so
 * a user signed into several Slack workspaces is steered to the right one.
 */
export function buildSlackAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  teamId: string;
}): string {
  const query = new URLSearchParams({
    response_type: "code",
    scope: "openid",
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
    nonce: params.nonce,
    team: params.teamId,
  });
  return `${SLACK_AUTHORIZE_URL}?${query.toString()}`;
}

/**
 * Decode and validate a Slack OIDC id_token.
 *
 * The id_token is received directly from Slack's token endpoint over a
 * server-to-server TLS channel authenticated with our client secret, so per
 * OpenID Connect Core §3.1.3.7 (6) the JWT signature MAY be trusted without a
 * JWKS round-trip. We still validate the security-relevant claims (iss, aud,
 * exp) so a token minted for a different audience or an expired one is
 * rejected.
 */
function decodeAndValidateIdToken(
  idToken: string,
  clientId: string,
): SlackOidcIdentity {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed Slack id_token");
  }

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
  } catch {
    throw new Error("Unparseable Slack id_token payload");
  }

  if (claims.iss !== SLACK_ISSUER) {
    throw new Error(`Unexpected id_token issuer: ${String(claims.iss)}`);
  }

  // `aud` may be a string or an array of strings per the JWT spec.
  const aud = claims.aud;
  const audMatches = Array.isArray(aud)
    ? aud.includes(clientId)
    : aud === clientId;
  if (!audMatches) {
    throw new Error("id_token audience does not match Slack client id");
  }

  if (typeof claims.exp === "number" && Date.now() >= claims.exp * 1000) {
    throw new Error("Slack id_token has expired");
  }

  const teamId = claims["https://slack.com/team_id"];
  const userId = claims["https://slack.com/user_id"];
  if (typeof teamId !== "string" || typeof userId !== "string") {
    throw new Error("Slack id_token missing team_id / user_id claims");
  }

  return {
    teamId,
    userId,
    nonce: typeof claims.nonce === "string" ? claims.nonce : null,
  };
}

/**
 * Exchange a Slack OIDC authorization code for the signed-in Slack identity.
 * Throws if the exchange fails or the id_token is invalid.
 */
export async function exchangeSlackOidcCode(
  code: string,
  redirectUri: string,
): Promise<SlackOidcIdentity> {
  const body = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    client_secret: config.SLACK_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch(SLACK_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    throw new Error("Failed to exchange Slack OIDC code");
  }

  const data = (await response.json()) as Record<string, unknown>;
  if (data.ok === false) {
    throw new Error(`Slack OIDC token error: ${String(data.error)}`);
  }

  const idToken = data.id_token;
  if (typeof idToken !== "string") {
    throw new Error("No id_token returned from Slack");
  }

  return decodeAndValidateIdToken(idToken, config.SLACK_CLIENT_ID);
}

/**
 * Hash a nonce/binding value for storage or comparison. Kept here so the OIDC
 * nonce and the browser-binding cookie use one consistent, non-reversible form.
 */
export function hashOidcValue(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}
