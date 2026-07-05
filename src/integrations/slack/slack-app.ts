import pkg, { App as BoltApp, ExpressReceiver as BoltReceiver } from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import { config } from "../../config.js";
import {
  handleLightGrantCommand,
  handleTeamOptionsLoad,
  handleRequestModalSubmission,
} from "./commands.js";
import {
  handleApproveAction,
  handleDenyAction,
  handleDenyModalSubmission,
  handlePolicyModalSubmission,
} from "./actions.js";
import { SlackNotifierService } from "../../services/slack-notifier.js";
import { GitHubClient } from "../github/github-client.js";
import Database from "better-sqlite3";
import { GitHubOrganizationContext } from "../../domain/github-organization-context.js";

let slackAppInstance: BoltApp | null = null;
let slackReceiverInstance: BoltReceiver | null = null;

/**
 * Initialize Slack Bolt App using ExpressReceiver.
 * Registers slash command, dynamic select, block actions, and view submissions.
 */
export function initSlackApp(
  db: Database.Database,
  orgContext: GitHubOrganizationContext,
): {
  app: BoltApp;
  receiver: BoltReceiver;
} {
  if (slackAppInstance && slackReceiverInstance) {
    return { app: slackAppInstance, receiver: slackReceiverInstance };
  }

  const receiver = new ExpressReceiver({
    signingSecret: config.SLACK_SIGNING_SECRET,
    endpoints: "/slack/events",
  });

  const app = new App({
    token: config.SLACK_BOT_TOKEN,
    receiver,
  });

  const notifier = new SlackNotifierService();
  const githubClient = new GitHubClient({
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_PRIVATE_KEY_BASE64,
    clientId: config.GITHUB_CLIENT_ID,
    clientSecret: config.GITHUB_CLIENT_SECRET,
    org: config.GITHUB_ORG,
  });

  // Slash Command Handler
  app.command("/lightgrant", async ({ command, ack, respond, client }) => {
    await handleLightGrantCommand({ command, ack, respond, client, db });
  });

  // Dynamic Options (External Select for Target Teams)
  app.options(/.*_select/, async ({ options, ack }) => {
    await handleTeamOptionsLoad({ options, ack, db });
  });

  // Modal Submissions
  app.view("request_modal_skeleton", async ({ view, body, ack, client }) => {
    await handleRequestModalSubmission({
      view,
      body,
      ack,
      db,
      notifier,
      githubClient,
      client,
    });
  });

  app.view("policy_modal_skeleton", async ({ view, body, ack, client }) => {
    await handlePolicyModalSubmission({
      view,
      body,
      ack,
      db,
      notifier,
      githubClient,
      client,
      orgContext,
    });
  });

  app.view("deny_reason_modal", async ({ view, body, ack }) => {
    await handleDenyModalSubmission({
      view,
      body,
      ack,
      db,
      notifier,
      githubClient,
    });
  });

  // Block Actions (Approve / Deny)
  app.action("approve_request", async ({ action, body, ack, respond }) => {
    await ack();
    await handleApproveAction({
      action,
      body,
      respond,
      db,
      githubClient,
      notifier,
    });
  });

  app.action("deny_request", async ({ action, body, ack, client }) => {
    await ack();
    await handleDenyAction({ action, body, client, db, githubClient });
  });

  slackAppInstance = app;
  slackReceiverInstance = receiver;

  return { app, receiver };
}

/**
 * Get the initialized Slack Bolt App instance.
 */
export function getSlackApp(): BoltApp | null {
  return slackAppInstance;
}
