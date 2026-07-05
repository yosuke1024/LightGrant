import { WebClient } from "@slack/web-api";
import { config } from "../config.js";
import { logger } from "../logger.js";

export interface SlackNotifier {
  postManualApproval(params: {
    requestId: string;
    slackUserId: string;
    githubLogin: string;
    teamName: string;
    durationMinutes: number;
    reason: string;
  }): Promise<{ channelId: string; messageTs: string }>;

  updateApprovalMessage(params: {
    channelId: string;
    messageTs: string;
    status: "approved" | "denied";
    approverSlackUserId: string;
    deniedReason?: string | null;
  }): Promise<void>;

  notifyRequester(params: {
    slackUserId: string;
    teamName: string;
    status: "approved" | "denied" | "already_present" | "grant_failed";
    durationMinutes?: number;
    deniedReason?: string | null;
  }): Promise<void>;

  postAuditLog(params: {
    requestId: string;
    slackUserId: string;
    githubLogin: string;
    teamName: string;
    durationMinutes: number;
    decisionMode: "auto" | "manual";
    approverSlackUserId?: string | null;
    status: "approved" | "denied" | "already_present" | "grant_failed";
    deniedReason?: string | null;
  }): Promise<void>;

  notifyRevocation(params: {
    slackUserId: string;
    teamName: string;
    wasPreexisting: boolean;
  }): Promise<void>;

  postAuditRevocation(params: {
    grantId: string;
    slackUserId: string;
    githubLogin: string;
    teamName: string;
    wasPreexisting: boolean;
    status: "revoked" | "failed";
    errorMessage?: string | null;
  }): Promise<void>;

  postPolicyDisabledAlert(params: {
    targetTeamName: string;
    ownerSlackUserId: string;
    ownerGithubLogin: string;
    disabledReason: string;
  }): Promise<void>;
}

/**
 * Service to handle Slack message formatting and delivery.
 */
export class SlackNotifierService implements SlackNotifier {
  private client: WebClient;

  constructor() {
    this.client = new WebClient(config.SLACK_BOT_TOKEN);
  }

  async postManualApproval(params: {
    requestId: string;
    slackUserId: string;
    githubLogin: string;
    teamName: string;
    durationMinutes: number;
    reason: string;
  }): Promise<{ channelId: string; messageTs: string }> {
    const channelId = config.SLACK_APPROVAL_CHANNEL_ID;

    logger.info(
      { requestId: params.requestId, channelId },
      "Posting manual approval message to Slack",
    );

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚨 *New GitHub Access Request*`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Requester:* <@${params.slackUserId}> (GitHub: @${params.githubLogin})`,
          },
          { type: "mrkdwn", text: `*Target Team:* \`${params.teamName}\`` },
          {
            type: "mrkdwn",
            text: `*Duration:* \`${params.durationMinutes} minutes\``,
          },
          { type: "mrkdwn", text: `*Reason:* ${params.reason}` },
        ],
      },
      {
        type: "actions",
        block_id: `approval_actions_${params.requestId}`,
        elements: [
          {
            type: "button",
            action_id: "approve_request",
            text: { type: "plain_text", text: "Approve" },
            style: "primary",
            value: params.requestId,
          },
          {
            type: "button",
            action_id: "deny_request",
            text: { type: "plain_text", text: "Deny" },
            style: "danger",
            value: params.requestId,
          },
        ],
      },
    ];

    const result = await this.client.chat.postMessage({
      channel: channelId,
      text: `New Access Request from <@${params.slackUserId}> for team \`${params.teamName}\``,
      blocks,
    });

    if (!result.ok || !result.ts) {
      throw new Error(
        `Failed to post message to Slack channel: ${result.error}`,
      );
    }

    return {
      channelId,
      messageTs: result.ts,
    };
  }

  async updateApprovalMessage(params: {
    channelId: string;
    messageTs: string;
    status: "approved" | "denied";
    approverSlackUserId: string;
    deniedReason?: string | null;
  }): Promise<void> {
    logger.info(
      { messageTs: params.messageTs },
      "Updating Slack approval message state",
    );

    const statusText =
      params.status === "approved"
        ? `✅ *Approved* by <@${params.approverSlackUserId}>`
        : `❌ *Denied* by <@${params.approverSlackUserId}>${params.deniedReason ? `\n*Reason:* ${params.deniedReason}` : ""}`;

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `🚨 *New GitHub Access Request*`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: statusText,
        },
      },
    ];

    await this.client.chat.update({
      channel: params.channelId,
      ts: params.messageTs,
      text: `Access Request decision made: ${params.status}`,
      blocks,
    });
  }

  async notifyRequester(params: {
    slackUserId: string;
    teamName: string;
    status: "approved" | "denied" | "already_present" | "grant_failed";
    durationMinutes?: number;
    deniedReason?: string | null;
  }): Promise<void> {
    logger.info(
      { slackUserId: params.slackUserId },
      "Notifying requester of decision",
    );

    let text = "";
    if (params.status === "approved") {
      text = `✅ Your request for access to the GitHub team \`${params.teamName}\` for ${params.durationMinutes} minutes has been *approved* and granted.`;
    } else if (params.status === "denied") {
      text = `❌ Your request for access to the GitHub team \`${params.teamName}\` has been *denied*.${params.deniedReason ? `\n*Reason:* ${params.deniedReason}` : ""}`;
    } else if (params.status === "already_present") {
      text = `ℹ️ Your request for access to the GitHub team \`${params.teamName}\` was *approved*, but you are already a member/maintainer of this team. No changes were made.`;
    } else if (params.status === "grant_failed") {
      text = `⚠️ Your request for access to the GitHub team \`${params.teamName}\` was *approved*, but LightGrant failed to apply the GitHub membership. An administrator has been notified.`;
    }

    await this.client.chat.postMessage({
      channel: params.slackUserId, // Directly posts to DM channel
      text,
    });
  }

  async postAuditLog(params: {
    requestId: string;
    slackUserId: string;
    githubLogin: string;
    teamName: string;
    durationMinutes: number;
    decisionMode: "auto" | "manual";
    approverSlackUserId?: string | null;
    status: "approved" | "denied" | "already_present" | "grant_failed";
    deniedReason?: string | null;
  }): Promise<void> {
    const channelId = config.SLACK_AUDIT_CHANNEL_ID;
    logger.info(
      { requestId: params.requestId, channelId },
      "Posting audit log message to Slack",
    );

    const modeText =
      params.decisionMode === "auto"
        ? "🤖 *Auto-Approved*"
        : "👤 *Manually Approved*";
    let decisionText = "";
    if (params.status === "approved") {
      decisionText = `${modeText} (Approver: ${params.approverSlackUserId ? `<@${params.approverSlackUserId}>` : "System"})`;
    } else if (params.status === "denied") {
      decisionText = `❌ *Manually Denied* by <@${params.approverSlackUserId}>${params.deniedReason ? `\n*Reason:* ${params.deniedReason}` : ""}`;
    } else if (params.status === "already_present") {
      decisionText = `${modeText} (Pre-existing membership; no action taken)`;
    } else if (params.status === "grant_failed") {
      decisionText = `🚨 *Grant Failed* after approval. Error: ${params.deniedReason || "unknown"}`;
    }

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📄 *Access Request Audit Log* (ID: \`${params.requestId}\`)`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*User:* <@${params.slackUserId}> (GitHub: @${params.githubLogin})`,
          },
          { type: "mrkdwn", text: `*Target Team:* \`${params.teamName}\`` },
          {
            type: "mrkdwn",
            text: `*Duration:* \`${params.durationMinutes} minutes\``,
          },
          { type: "mrkdwn", text: `*Status:* ${decisionText}` },
        ],
      },
    ];

    await this.client.chat.postMessage({
      channel: channelId,
      text: `Audit log for request ${params.requestId}: ${params.status} (${params.decisionMode})`,
      blocks,
    });
  }

  async notifyRevocation(params: {
    slackUserId: string;
    teamName: string;
    wasPreexisting: boolean;
  }): Promise<void> {
    logger.info(
      { slackUserId: params.slackUserId },
      "Sending revocation notification to requester",
    );

    const text = params.wasPreexisting
      ? `ℹ️ Your temporary access request period for GitHub team \`${params.teamName}\` has ended. Since you already possessed this membership beforehand, your GitHub membership remains intact.`
      : `🔏 Your temporary access to the GitHub team \`${params.teamName}\` has expired and has been automatically revoked.`;

    await this.client.chat.postMessage({
      channel: params.slackUserId,
      text,
    });
  }

  async postAuditRevocation(params: {
    grantId: string;
    slackUserId: string;
    githubLogin: string;
    teamName: string;
    wasPreexisting: boolean;
    status: "revoked" | "failed";
    errorMessage?: string | null;
  }): Promise<void> {
    const channelId = config.SLACK_AUDIT_CHANNEL_ID;
    logger.info(
      { grantId: params.grantId, channelId },
      "Posting revocation audit log to Slack",
    );

    let statusText = "";
    if (params.status === "revoked") {
      statusText = params.wasPreexisting
        ? "ℹ️ *Revocation Skipped* (Preexisting membership protected)"
        : "🔏 *Automatically Revoked*";
    } else {
      statusText = `🚨 *Revocation Failed* (Attempts logged)${params.errorMessage ? `\n*Error:* ${params.errorMessage}` : ""}`;
    }

    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `📄 *Membership Revocation Audit Log* (Grant ID: \`${params.grantId}\`)`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*User:* <@${params.slackUserId}> (GitHub: @${params.githubLogin})`,
          },
          { type: "mrkdwn", text: `*Target Team:* \`${params.teamName}\`` },
          { type: "mrkdwn", text: `*Status:* ${statusText}` },
        ],
      },
    ];

    await this.client.chat.postMessage({
      channel: channelId,
      text: `Audit log for revocation ${params.grantId}: ${params.status}`,
      blocks,
    });
  }

  async postPolicyDisabledAlert(params: {
    targetTeamName: string;
    ownerSlackUserId: string;
    ownerGithubLogin: string;
    disabledReason: string;
  }): Promise<void> {
    const channelId = config.SLACK_AUDIT_CHANNEL_ID;
    const blocks = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `⚠️ *Auto-Approval Policy Disabled*`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Target Team:* \`${params.targetTeamName}\``,
          },
          {
            type: "mrkdwn",
            text: `*Owner:* <@${params.ownerSlackUserId}> (GitHub: @${params.ownerGithubLogin})`,
          },
          { type: "mrkdwn", text: `*Reason:* \`${params.disabledReason}\`` },
        ],
      },
    ];

    await this.client.chat.postMessage({
      channel: channelId,
      text: `Policy disabled for team ${params.targetTeamName}`,
      blocks,
    });
  }
}
