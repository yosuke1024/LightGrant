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

export const oauthRouter = Router();

/**
 * Endpoint to start GitHub User OAuth.
 * Validates the state token and redirects user to GitHub's authorization page.
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

  const authorizeUrl = `https://github.com/login/oauth/authorize?client_id=${config.GITHUB_CLIENT_ID}&redirect_uri=${encodeURIComponent(`${config.PUBLIC_BASE_URL}/auth/github/callback`)}&state=${encodeURIComponent(stateToken)}`;

  res.redirect(authorizeUrl);
});

/**
 * Callback endpoint for GitHub OAuth.
 * Exchanges auth code for access token, gets user details, and creates identity mapping.
 */
oauthRouter.get("/auth/github/callback", async (req: Request, res: Response) => {
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

  // Consume state immediately to prevent replay attacks
  const timestamp = new Date().toISOString();
  oauthRepo.markAsUsed(dbState.id, timestamp);

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
      throw new Error("Failed to exchange authorization code for access token");
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
          dbState.resume_action_type === "approve_request" ? "approve" : "deny";
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
});
