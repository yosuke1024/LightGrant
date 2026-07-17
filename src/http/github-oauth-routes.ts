import { Router, Request, Response } from "express";
import crypto from "crypto";
import { verifyStateToken } from "../security/signed-state.js";
import { OAuthStateRepository } from "../persistence/repositories/oauth-state-repository.js";
import { IdentityRepository } from "../persistence/repositories/identity-repository.js";
import { RequestRepository } from "../persistence/repositories/request-repository.js";
import { AuditRepository } from "../persistence/repositories/audit-repository.js";
import { getDatabase } from "../persistence/database.js";
import { config } from "../config.js";
import { GitHubClient } from "../integrations/github/github-client.js";
import { logger } from "../logger.js";
import { WebClient } from "@slack/web-api";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackOidcCode,
  hashOidcValue,
} from "../security/slack-oidc.js";
import { parseCookies, serializeCookie } from "../security/cookies.js";
import { secureTokenEquals } from "../security/secure-compare.js";

export const oauthRouter = Router();

/**
 * Name of the one-time, HttpOnly cookie that binds the browser which passed
 * "Sign in with Slack" to the GitHub OAuth callback of the SAME flow.
 */
const BINDING_COOKIE = "lg_bind";

/**
 * The binding cookie only has to survive the Slack-callback -> GitHub-authorize
 * -> GitHub-callback hop, so it is short-lived.
 */
const BINDING_TTL_SECONDS = 300;

/** Secure cookies require HTTPS; relax only for local http dev/test. */
function cookieSecure(): boolean {
  return config.NODE_ENV === "production";
}

function clearBindingCookie(res: Response): void {
  res.setHeader(
    "Set-Cookie",
    serializeCookie(BINDING_COOKIE, "", {
      maxAgeSeconds: 0,
      secure: cookieSecure(),
    }),
  );
}

/**
 * Minimal HTML page for a hard security refusal. Kept separate from the
 * account-link "conflict" pages so operators can distinguish a benign conflict
 * from a blocked takeover attempt in screenshots / user reports.
 */
function securityErrorPage(message: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <title>LightGrant Security Check</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px; background-color: #fff0f0; }
        .card { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1px solid #ffc1c1; }
        h1 { color: #d32f2f; font-size: 24px; margin-bottom: 20px; }
        p { color: #5c2525; font-size: 16px; line-height: 1.5; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Verification Failed</h1>
        <p>${message}</p>
        <p>Please start again from Slack with <code>/lightgrant</code>.</p>
      </div>
    </body>
    </html>
  `;
}

/**
 * Endpoint to start GitHub User OAuth.
 *
 * Instead of redirecting straight to GitHub, this now begins a "Sign in with
 * Slack" (OIDC) leg. That proves the browser belongs to the Slack user named
 * in the signed state before any GitHub authorization happens, closing the
 * forwarded-URL account-takeover hole (see migration 0015).
 */
oauthRouter.get("/auth/github/start", async (req, res) => {
  const stateToken = req.query.state as string;
  if (!stateToken) {
    logger.warn("OAuth start request missing state token");
    return res.status(400).send("Bad Request: Missing state parameter.");
  }

  const payload = verifyStateToken(stateToken);
  if (!payload) {
    logger.warn("OAuth start request has invalid or expired state token");
    return res.status(400).send("Bad Request: Invalid or expired state.");
  }

  const db = getDatabase();
  const oauthRepo = new OAuthStateRepository(db);

  const nonceHash = crypto
    .createHash("sha256")
    .update(payload.nonce)
    .digest("hex");
  const dbState = oauthRepo.getStateByNonceHash(nonceHash);

  if (!dbState || dbState.used_at !== null) {
    logger.warn(
      { nonceHash },
      "OAuth start request state not found or already used",
    );
    return res.status(400).send("Bad Request: State token is not valid.");
  }

  // Begin the Sign in with Slack leg. Store the hash of the OIDC nonce so the
  // Slack callback can fence a replayed authorization code.
  const oidcNonce = crypto.randomBytes(32).toString("hex");
  oauthRepo.setOidcNonceHash(dbState.id, hashOidcValue(oidcNonce));

  const authorizeUrl = buildSlackAuthorizeUrl({
    clientId: config.SLACK_CLIENT_ID,
    redirectUri: `${config.PUBLIC_BASE_URL}/auth/slack/callback`,
    // Reuse the signed state token as the OIDC state: it is tamper-proof and
    // already maps back to this flow via its nonce hash.
    state: stateToken,
    nonce: oidcNonce,
    teamId: dbState.slack_workspace_id,
  });

  res.redirect(authorizeUrl);
});

/**
 * Callback for "Sign in with Slack" (OIDC).
 *
 * Confirms the browser's Slack identity equals the Slack user recorded in the
 * state, then issues a one-time browser-binding cookie and hands off to GitHub
 * OAuth. A mismatch here is the takeover attempt itself — refuse it.
 */
oauthRouter.get("/auth/slack/callback", async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const stateToken = req.query.state as string;

  if (!code || !stateToken) {
    logger.warn("Slack OIDC callback missing code or state");
    return res
      .status(400)
      .send("Bad Request: Missing code or state parameter.");
  }

  const payload = verifyStateToken(stateToken);
  if (!payload) {
    logger.warn("Slack OIDC callback has invalid or expired state token");
    return res.status(400).send("Bad Request: State is invalid or expired.");
  }

  const db = getDatabase();
  const oauthRepo = new OAuthStateRepository(db);

  const nonceHash = crypto
    .createHash("sha256")
    .update(payload.nonce)
    .digest("hex");
  const dbState = oauthRepo.getStateByNonceHash(nonceHash);

  if (!dbState) {
    logger.warn({ nonceHash }, "Slack OIDC callback state not found in DB");
    return res.status(400).send("Bad Request: State not recognized.");
  }

  if (dbState.used_at !== null) {
    logger.warn(
      { nonceHash },
      "Slack OIDC callback for an already-consumed state",
    );
    return res.status(400).send("Bad Request: State already consumed.");
  }

  try {
    const identity = await exchangeSlackOidcCode(
      code,
      `${config.PUBLIC_BASE_URL}/auth/slack/callback`,
    );

    // Fence a replayed Slack authorization code: the id_token nonce must match
    // the nonce we minted for THIS flow at /auth/github/start.
    if (
      dbState.oidc_nonce_hash &&
      (!identity.nonce ||
        !secureTokenEquals(
          hashOidcValue(identity.nonce),
          dbState.oidc_nonce_hash,
        ))
    ) {
      logger.warn(
        { nonceHash, slackUser: dbState.slack_user_id },
        "Slack OIDC nonce mismatch — possible code replay",
      );
      return res
        .status(400)
        .send(securityErrorPage("Your sign-in could not be verified."));
    }

    // The crux: the signed-in Slack user must be the one this flow was started
    // for. If not, someone forwarded a connect URL meant for another account.
    if (
      identity.teamId !== dbState.slack_workspace_id ||
      identity.userId !== dbState.slack_user_id
    ) {
      logger.warn(
        {
          expectedWorkspace: dbState.slack_workspace_id,
          expectedUser: dbState.slack_user_id,
          actualWorkspace: identity.teamId,
          actualUser: identity.userId,
        },
        "Slack OIDC identity mismatch — refusing to bind (possible account takeover attempt)",
      );
      return res
        .status(403)
        .send(
          securityErrorPage(
            "You are signed in to Slack as a different user than the one that started this request.",
          ),
        );
    }

    // Issue the one-time browser-binding token. markSlackVerified only mutates
    // rows that are still unverified and unused, so re-driving this leg cannot
    // mint a second cookie for the same flow.
    const bindingToken = crypto.randomBytes(32).toString("hex");
    const verified = oauthRepo.markSlackVerified(
      dbState.id,
      new Date().toISOString(),
      hashOidcValue(bindingToken),
    );
    if (!verified) {
      logger.warn(
        { nonceHash },
        "Slack OIDC leg already completed for this flow",
      );
      return res.status(400).send("Bad Request: State already verified.");
    }

    res.setHeader(
      "Set-Cookie",
      serializeCookie(BINDING_COOKIE, bindingToken, {
        maxAgeSeconds: BINDING_TTL_SECONDS,
        secure: cookieSecure(),
      }),
    );

    const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${config.GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(`${config.PUBLIC_BASE_URL}/auth/github/callback`)}&state=${encodeURIComponent(stateToken)}`;
    res.redirect(authorizeUrl);
  } catch (error) {
    logger.error({ error }, "Error completing Slack OIDC sign-in");
    res
      .status(500)
      .send("Internal Server Error: Failed to verify Slack identity.");
  }
});

/**
 * Callback endpoint for GitHub OAuth.
 * Exchanges auth code for access token, gets user details, and creates identity mapping.
 */
oauthRouter.get(
  "/auth/github/callback",
  async (req: Request, res: Response) => {
    const code = req.query.code as string;
    const stateToken = req.query.state as string;

    if (!code || !stateToken) {
      logger.warn("OAuth callback request missing code or state");
      return res
        .status(400)
        .send("Bad Request: Missing code or state parameter.");
    }

    const payload = verifyStateToken(stateToken);
    if (!payload) {
      logger.warn("OAuth callback has invalid or expired state token");
      return res.status(400).send("Bad Request: State is invalid or expired.");
    }

    const db = getDatabase();
    const oauthRepo = new OAuthStateRepository(db);

    const nonceHash = crypto
      .createHash("sha256")
      .update(payload.nonce)
      .digest("hex");
    const dbState = oauthRepo.getStateByNonceHash(nonceHash);

    if (!dbState) {
      logger.warn({ nonceHash }, "OAuth callback state not found in DB");
      return res.status(400).send("Bad Request: State not recognized.");
    }

    if (dbState.used_at !== null) {
      logger.warn(
        { nonceHash },
        "OAuth callback replay attack detected: state already used",
      );
      return res.status(400).send("Bad Request: State already consumed.");
    }

    // Browser-binding gate: only a browser that just completed "Sign in with
    // Slack" for THIS flow may finish the link. This is what stops a victim who
    // opened a forwarded GitHub-authorize URL (they carry no binding cookie) and
    // a state that somehow skipped the Slack leg (slack_verified_at is null).
    const presentedBinding = parseCookies(req.headers.cookie)[BINDING_COOKIE];
    if (
      dbState.slack_verified_at === null ||
      dbState.binding_token_hash === null ||
      !presentedBinding ||
      !secureTokenEquals(
        hashOidcValue(presentedBinding),
        dbState.binding_token_hash,
      )
    ) {
      logger.warn(
        {
          nonceHash,
          slackVerified: dbState.slack_verified_at !== null,
          hasBindingCookie: Boolean(presentedBinding),
        },
        "OAuth callback missing/invalid browser binding — refusing to link (possible account takeover attempt)",
      );
      clearBindingCookie(res);
      return res
        .status(403)
        .send(
          securityErrorPage(
            "This browser was not verified with Slack for this request.",
          ),
        );
    }

    // Consume state immediately to prevent replay attacks. This also clears the
    // binding token hash so the one-time cookie can never link twice.
    const timestamp = new Date().toISOString();
    oauthRepo.markAsUsed(dbState.id, timestamp);
    clearBindingCookie(res);

    try {
      // Exchange authorization code for token
      const tokenResponse = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify({
            client_id: config.GITHUB_CLIENT_ID,
            client_secret: config.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: `${config.PUBLIC_BASE_URL}/auth/github/callback`,
          }),
        },
      );

      if (!tokenResponse.ok) {
        throw new Error(
          "Failed to exchange authorization code for access token",
        );
      }

      const tokenData = (await tokenResponse.json()) as Record<string, unknown>;
      const accessToken = tokenData.access_token as string | undefined;
      if (!accessToken) {
        throw new Error("No access_token returned from GitHub");
      }

      const githubClient = new GitHubClient({
        appId: config.GITHUB_APP_ID,
        privateKey: config.GITHUB_PRIVATE_KEY_BASE64,
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        org: config.GITHUB_ORG,
      });

      const githubUser = await githubClient.getAuthenticatedUser(accessToken);

      const identityRepo = new IdentityRepository(db);

      const existingSlackLink = identityRepo.getLinkBySlackUser(
        dbState.slack_workspace_id,
        dbState.slack_user_id,
      );

      const existingGitLink = identityRepo.getLinkByGitHubUser(
        dbState.slack_workspace_id,
        githubUser.id,
      );

      // Enforce Case C: Same Slack user, but tries to connect a DIFFERENT GitHub account
      if (
        existingSlackLink &&
        existingSlackLink.github_user_id !== githubUser.id
      ) {
        logger.warn(
          {
            slackUser: dbState.slack_user_id,
            currentGithub: existingSlackLink.github_user_id,
            newGithub: githubUser.id,
          },
          "OAuth Link Conflict (Case C): Slack user already linked to another GitHub account",
        );
        return res.status(409).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>LightGrant Error</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px; background-color: #fff0f0; }
            .card { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1px solid #ffc1c1; }
            h1 { color: #d32f2f; font-size: 24px; margin-bottom: 20px; }
            p { color: #5c2525; font-size: 16px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Account Link Conflict</h1>
            <p>This Slack account is already linked to another GitHub account.</p>
            <p>Unlink it explicitly before connecting a different account.</p>
          </div>
        </body>
        </html>
      `);
      }

      // Enforce Case D: Different Slack user, but GitHub account is ALREADY linked to another Slack user
      if (
        existingGitLink &&
        existingGitLink.slack_user_id !== dbState.slack_user_id
      ) {
        logger.warn(
          {
            githubUser: githubUser.login,
            currentSlack: existingGitLink.slack_user_id,
            newSlack: dbState.slack_user_id,
          },
          "OAuth Link Conflict (Case D): GitHub account already linked to another Slack user",
        );
        return res.status(409).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>LightGrant Error</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px; background-color: #fff0f0; }
            .card { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1px solid #ffc1c1; }
            h1 { color: #d32f2f; font-size: 24px; margin-bottom: 20px; }
            p { color: #5c2525; font-size: 16px; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Account Link Conflict</h1>
            <p>This GitHub account is already linked to another Slack user in this workspace.</p>
            <p>Contact a LightGrant administrator if this mapping is incorrect.</p>
          </div>
        </body>
        </html>
      `);
      }

      if (
        existingSlackLink &&
        existingSlackLink.github_user_id === githubUser.id
      ) {
        // Case B: Same Slack user, same GitHub account -> Update last verified & login
        db.transaction(() => {
          identityRepo.updateLastVerified(
            existingSlackLink.id,
            githubUser.login,
            timestamp,
          );

          const auditRepo = new AuditRepository(db);
          auditRepo.writeEventTx({
            eventType: "identity_linked",
            actorType: "user",
            actorId: existingSlackLink.id,
            slackWorkspaceId: dbState.slack_workspace_id,
            slackUserId: dbState.slack_user_id,
            githubUserId: githubUser.id,
            payloadJson: JSON.stringify({
              githubLogin: githubUser.login,
              updateType: "reverify",
            }),
          });
        })();
        logger.info(
          { slackUser: dbState.slack_user_id, githubLogin: githubUser.login },
          "Identity mapping re-verified and updated",
        );
      } else {
        // Case A: Fresh link creation
        const linkId = crypto.randomUUID();
        db.transaction(() => {
          identityRepo.createLink(
            linkId,
            dbState.slack_workspace_id,
            dbState.slack_user_id,
            githubUser.id,
            githubUser.login,
            timestamp,
          );

          const auditRepo = new AuditRepository(db);
          auditRepo.writeEventTx({
            eventType: "identity_linked",
            actorType: "user",
            actorId: linkId,
            slackWorkspaceId: dbState.slack_workspace_id,
            slackUserId: dbState.slack_user_id,
            githubUserId: githubUser.id,
            payloadJson: JSON.stringify({
              githubLogin: githubUser.login,
              updateType: "create",
            }),
          });
        })();
        logger.info(
          { slackUser: dbState.slack_user_id, githubLogin: githubUser.login },
          "Identity linked successfully",
        );
      }

      // Try to resume pending actions if applicable
      if (dbState.resume_action_type && dbState.resume_action_id) {
        const requestRepo = new RequestRepository(db);
        const pendingReq = requestRepo.getRequest(dbState.resume_action_id);
        if (pendingReq && pendingReq.decision_status === "pending") {
          const webClient = new WebClient(config.SLACK_BOT_TOKEN);
          const actionType =
            dbState.resume_action_type === "approve_request"
              ? "approve"
              : "deny";
          const buttonStyle = actionType === "approve" ? "primary" : "danger";
          const buttonText =
            actionType === "approve" ? "Approve Now" : "Deny (Enter Reason)";

          try {
            await webClient.chat.postMessage({
              channel: dbState.slack_user_id,
              text: `GitHub account connected. You can now resume your decision for request *#${pendingReq.id}*.`,
              blocks: [
                {
                  type: "section",
                  text: {
                    type: "mrkdwn",
                    text: `GitHub account connected. Resume your decision for request *#${pendingReq.id}*?`,
                  },
                },
                {
                  type: "actions",
                  elements: [
                    {
                      type: "button",
                      text: {
                        type: "plain_text",
                        text: buttonText,
                      },
                      style: buttonStyle as "primary" | "danger",
                      action_id: dbState.resume_action_type,
                      value: pendingReq.id,
                    },
                  ],
                },
              ],
            });
          } catch (slackErr) {
            logger.error(
              { slackErr },
              "Failed to send OAuth resume notification message to Slack",
            );
          }
        }
      }

      res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>LightGrant Authentication</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; padding: 50px; background-color: #f6f8fa; }
          .card { max-width: 500px; margin: 0 auto; background: white; padding: 40px; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1px solid #e1e4e8; }
          h1 { color: #2ea44f; font-size: 24px; margin-bottom: 20px; }
          p { color: #586069; font-size: 16px; line-height: 1.5; }
        </style>
      </head>
      <body>
        <div class="card">
          <h1>GitHub Account Connected Successfully!</h1>
          <p>Your Slack account has been successfully linked with <strong>@${githubUser.login}</strong>.</p>
          <p>You can now close this window and request access in Slack.</p>
        </div>
      </body>
      </html>
    `);
    } catch (error) {
      logger.error({ error }, "Error exchanging GitHub OAuth code");
      res
        .status(500)
        .send("Internal Server Error: Failed to complete authentication.");
    }
  },
);
