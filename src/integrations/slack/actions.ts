import crypto from "crypto";
import Database from "better-sqlite3";
import { RequestRepository } from "../../persistence/repositories/request-repository.js";
import { IdentityRepository } from "../../persistence/repositories/identity-repository.js";
import { ApprovalRepository } from "../../persistence/repositories/approval-repository.js";
import { OAuthStateRepository } from "../../persistence/repositories/oauth-state-repository.js";
import { TeamRepository } from "../../persistence/repositories/team-repository.js";
import { PolicyRepository } from "../../persistence/repositories/policy-repository.js";
import { PolicyService } from "../../services/policy-service.js";
import { AuditRepository } from "../../persistence/repositories/audit-repository.js";
import { generateStateToken } from "../../security/signed-state.js";
import { config } from "../../config.js";
import { SlackNotifier } from "../../services/slack-notifier.js";
import { GitHubClient } from "../github/github-client.js";
import { AuthorizationService } from "../../services/authorization-service.js";
import { GrantService } from "../../services/grant-service.js";
import { logger } from "../../logger.js";
import { GitHubOrganizationContext } from "../../domain/github-organization-context.js";

export interface ApproveActionContext {
  action: unknown;
  body: unknown;
  respond: unknown;
  db: Database.Database;
  githubClient: GitHubClient;
  notifier: SlackNotifier;
}

/**
 * Handle clicking the [Approve] button in the manual approval channel.
 * Checks approver's Identity Link and GitHub permissions (team maintainer or org owner),
 * grants team membership, updates Slack approval message, and notifies requester.
 */
export async function handleApproveAction(
  context: ApproveActionContext,
): Promise<void> {
  const { action, body, respond, db, githubClient, notifier } = context;
  const typedAction = action as { value: string };
  const typedBody = body as { user: { id: string; team_id: string } };
  const typedRespond = respond as (message: string | object) => Promise<unknown>;
  const requestId = typedAction.value;
  const slackWorkspaceId = typedBody.user.team_id;
  const approverSlackUserId = typedBody.user.id;

  const requestRepo = new RequestRepository(db);
  const req = requestRepo.getRequest(requestId);
  if (!req) {
    logger.warn(
      { requestId },
      "Approve action triggered for non-existent request",
    );
    return;
  }

  // Idempotency check: only pending requests can be approved
  if (req.decision_status !== "pending") {
    await typedRespond({
      text: `This request has already been ${req.decision_status}.`,
      response_type: "ephemeral",
    });
    return;
  }

  const identityRepo = new IdentityRepository(db);
  const approverLink = identityRepo.getLinkBySlackUser(
    slackWorkspaceId,
    approverSlackUserId,
  );

  if (!approverLink) {
    // Generate secure state for unlinked approver connection
    const nonce = crypto.randomBytes(32).toString("hex");
    const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");
    const stateId = crypto.randomUUID();
    const expiresAtMs = Date.now() + 600000;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const timestamp = new Date().toISOString();

    const oauthStateRepo = new OAuthStateRepository(db);
    oauthStateRepo.createState(
      stateId,
      nonceHash,
      slackWorkspaceId,
      approverSlackUserId,
      "approve_request",
      requestId,
      expiresAt,
      timestamp,
    );

    const token = generateStateToken(
      slackWorkspaceId,
      approverSlackUserId,
      nonce,
      expiresAtMs,
    );
    const authUrl = `${config.PUBLIC_BASE_URL}/auth/github/start?state=${token}`;

    await typedRespond({
      text: `GitHub account connection is required before approving access requests.\n<${authUrl}|Connect GitHub>`,
      response_type: "ephemeral",
    });
    return;
  }

  try {
    // Verify authority using unified AuthorizationService
    const authService = new AuthorizationService(githubClient);
    const auth = await authService.verifyRequestDecisionAuthority({
      targetTeamId: req.target_team_id,
      githubUserId: approverLink.github_user_id,
    });

    if (!auth.authorized) {
      await typedRespond({
        text: "You do not have permission to approve this request (must be a team maintainer or organization owner).",
        response_type: "ephemeral",
      });
      return;
    }

    // Retrieve requester identity info
    const requesterLink = identityRepo.getLink(req.requester_identity_id);
    if (!requesterLink) {
      throw new Error(
        `Requester identity link not found for ID: ${req.requester_identity_id}`,
      );
    }

    // Verify requester's active organization membership before granting
    let isOrgMember = false;
    try {
      const orgMembership = await githubClient.getOrganizationMembership(
        requesterLink.github_user_id,
      );
      isOrgMember = orgMembership ? orgMembership.state === "active" : false;
    } catch (err) {
      if ((err as Error).name !== "GitHubNotFoundError") {
        throw err;
      }
    }

    if (!isOrgMember) {
      logger.warn(
        { requesterGithubUserId: requesterLink.github_user_id },
        "Requester is not an active member of the target GitHub organization",
      );
      await typedRespond({
        text: "Approval failed. The requester is not an active member of the GitHub organization.\nAsk an organization owner to complete their organization invitation first.",
        response_type: "ephemeral",
      });
      return;
    }

    // Use GrantService to perform decision updates, integration checks, and Job queuing in a transaction.
    const grantService = new GrantService(db);
    try {
      grantService.createGrantIntentTx({
        requestId,
        decisionMode: "manual",
        approverIdentityId: approverLink.id,
        approverGithubUserId: approverLink.github_user_id,
        authorityRole: auth.authorityRole || "team_maintainer",
        decisionReason: null,
      });
    } catch (err) {
      logger.warn(
        { err, requestId },
        "Decision already processed or transaction failed",
      );
      await typedRespond({
        text: "This request has already been processed by another decision or validation failed.",
        response_type: "ephemeral",
      });
      return;
    }

    // Update manual approval message in Slack channel to show approved status
    if (req.slack_approval_channel_id && req.slack_approval_message_ts) {
      await notifier.updateApprovalMessage({
        channelId: req.slack_approval_channel_id,
        messageTs: req.slack_approval_message_ts,
        status: "approved",
        approverSlackUserId,
      });
    }

    // Inform approver that non-blocking grant process has started
    await typedRespond({
      text: `Request *#${requestId}* has been approved. LightGrant is applying the GitHub membership now.`,
      replace_original: true,
    });
  } catch (error) {
    logger.error({ error, requestId }, "Error executing approval action");
    await typedRespond({
      text: "An error occurred while processing the approval request.",
      response_type: "ephemeral",
    });
  }
}

export interface DenyActionContext {
  action: unknown;
  body: unknown;
  client: unknown;
  db: Database.Database;
  githubClient: GitHubClient;
}

/**
 * Handle clicking the [Deny] button in the manual approval channel.
 * Opens the Slack modal to input rejection reason.
 */
export async function handleDenyAction(
  context: DenyActionContext,
): Promise<void> {
  const { action, body, client, db, githubClient } = context;
  const typedAction = action as { value: string };
  const typedBody = body as {
    user: { id: string; team_id: string };
    channel: { id: string };
    trigger_id: string;
  };
  const typedClient = client as {
    chat: {
      postEphemeral: (options: { channel: string; user: string; text: string }) => Promise<unknown>;
    };
    views: {
      open: (options: { trigger_id: string; view: unknown }) => Promise<unknown>;
    };
  };
  const requestId = typedAction.value;
  const slackWorkspaceId = typedBody.user.team_id;
  const approverSlackUserId = typedBody.user.id;

  const requestRepo = new RequestRepository(db);
  const req = requestRepo.getRequest(requestId);
  if (!req) {
    logger.warn(
      { requestId },
      "Deny action triggered for non-existent request",
    );
    return;
  }

  // Idempotency check: only pending requests can be denied
  if (req.decision_status !== "pending") {
    try {
      await typedClient.chat.postEphemeral({
        channel: typedBody.channel.id,
        user: approverSlackUserId,
        text: `This request has already been ${req.decision_status}.`,
      });
    } catch (err) {
      logger.error(
        { err },
        "Failed to send ephemeral message for duplicate decision",
      );
    }
    return;
  }

  const identityRepo = new IdentityRepository(db);
  const approverLink = identityRepo.getLinkBySlackUser(
    slackWorkspaceId,
    approverSlackUserId,
  );

  if (!approverLink) {
    // Generate secure state for unlinked approver connection
    const nonce = crypto.randomBytes(32).toString("hex");
    const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");
    const stateId = crypto.randomUUID();
    const expiresAtMs = Date.now() + 600000;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const timestamp = new Date().toISOString();

    const oauthStateRepo = new OAuthStateRepository(db);
    oauthStateRepo.createState(
      stateId,
      nonceHash,
      slackWorkspaceId,
      approverSlackUserId,
      "deny_request",
      requestId,
      expiresAt,
      timestamp,
    );

    const token = generateStateToken(
      slackWorkspaceId,
      approverSlackUserId,
      nonce,
      expiresAtMs,
    );
    const authUrl = `${config.PUBLIC_BASE_URL}/auth/github/start?state=${token}`;

    try {
      await typedClient.chat.postEphemeral({
        channel: typedBody.channel.id,
        user: approverSlackUserId,
        text: `GitHub account connection is required before denying access requests.\n<${authUrl}|Connect GitHub>`,
      });
    } catch (err) {
      logger.error({ err }, "Failed to send ephemeral message for OAuth link");
    }
    return;
  }

  // Verify approver authority
  const authService = new AuthorizationService(githubClient);
  const auth = await authService.verifyRequestDecisionAuthority({
    targetTeamId: req.target_team_id,
    githubUserId: approverLink.github_user_id,
  });

  if (!auth.authorized) {
    try {
      await typedClient.chat.postEphemeral({
        channel: typedBody.channel.id,
        user: approverSlackUserId,
        text: "You do not have permission to deny this request (must be a team maintainer or organization owner).",
      });
    } catch (err) {
      logger.error({ err }, "Failed to send ephemeral message");
    }
    return;
  }

  // Open modal requesting denial reason, passing requestId in private_metadata
  await typedClient.views.open({
    trigger_id: typedBody.trigger_id,
    view: {
      type: "modal",
      callback_id: "deny_reason_modal",
      private_metadata: requestId,
      title: {
        type: "plain_text",
        text: "Deny Request",
      },
      submit: {
        type: "plain_text",
        text: "Deny",
      },
      blocks: [
        {
          type: "input",
          block_id: "reason_block",
          element: {
            type: "plain_text_input",
            action_id: "reason_input",
            multiline: true,
            placeholder: {
              type: "plain_text",
              text: "Provide rejection reason...",
            },
          },
          label: {
            type: "plain_text",
            text: "Rejection Reason",
          },
        },
      ],
    },
  });
}

export interface DenyModalSubmissionContext {
  view: unknown;
  body: unknown;
  ack: unknown;
  db: Database.Database;
  notifier: SlackNotifier;
  githubClient: GitHubClient;
}

/**
 * Handles submission of the denial reason modal.
 * Saves denied status in DB, updates Slack approval message, and notifies requester.
 */
export async function handleDenyModalSubmission(
  context: DenyModalSubmissionContext,
): Promise<void> {
  const { view, body, ack, db, notifier, githubClient } = context;
  const typedView = view as {
    private_metadata: string;
    state: {
      values: {
        reason_block?: {
          reason_input?: {
            value?: string;
          };
        };
      };
    };
  };
  const typedBody = body as { user: { id: string; team_id: string } };
  const typedAck = ack as (response?: unknown) => Promise<void>;
  const requestId = typedView.private_metadata;
  const reasonVal = typedView.state.values.reason_block?.reason_input?.value;

  const reason = reasonVal ? reasonVal.trim() : "No reason provided";

  const requestRepo = new RequestRepository(db);
  const req = requestRepo.getRequest(requestId);
  if (!req) {
    logger.error(
      { requestId },
      "Deny modal submitted for non-existent request",
    );
    await typedAck();
    return;
  }

  const slackWorkspaceId = typedBody.user.team_id;
  const approverSlackUserId = typedBody.user.id;
  const timestamp = new Date().toISOString();

  const identityRepo = new IdentityRepository(db);
  const approverLink = identityRepo.getLinkBySlackUser(
    slackWorkspaceId,
    approverSlackUserId,
  );
  if (!approverLink) {
    logger.error(
      { approverSlackUserId },
      "Deny modal submitter identity link not found",
    );
    await typedAck();
    return;
  }

  // Live check decision authority before accepting submission
  const authService = new AuthorizationService(githubClient);
  const auth = await authService.verifyRequestDecisionAuthority({
    targetTeamId: req.target_team_id,
    githubUserId: approverLink.github_user_id,
  });

  if (!auth.authorized) {
    await typedAck({
      response_action: "errors",
      errors: {
        reason_block:
          "You do not have permission to deny this request (must be a team maintainer or organization owner).",
      },
    });
    return;
  }

  // Close modal successfully
  await typedAck();

  // Update request status to denied with Compare-and-Set and insert Audit Log within transaction
  const requesterLink = identityRepo.getLink(req.requester_identity_id);
  const success = db.transaction(() => {
    const affected = requestRepo.updateDecisionStatus(
      requestId,
      "denied",
      "manual",
      timestamp,
      reason,
    );

    if (affected !== 1) {
      return false;
    }

    const approvalRepo = new ApprovalRepository(db);
    const approvalId = crypto.randomUUID();
    approvalRepo.createApproval({
      id: approvalId,
      accessRequestId: requestId,
      decision: "denied",
      approverIdentityId: approverLink.id,
      approverGithubUserId: approverLink.github_user_id,
      authorityRole: auth.authorityRole || "team_maintainer",
      authorityVerifiedAt: timestamp,
      reason,
      createdAt: timestamp,
    });

    const auditRepo = new AuditRepository(db);
    auditRepo.writeEventTx({
      eventType: "request_denied",
      actorType: "user",
      actorId: approverLink.id,
      slackWorkspaceId,
      slackUserId: approverSlackUserId,
      githubOrgId: req.github_org_id,
      githubUserId: requesterLink ? requesterLink.github_user_id : null,
      githubTeamId: req.target_team_id,
      accessRequestId: requestId,
      payloadJson: JSON.stringify({
        deniedReason: reason,
      }),
    });

    return true;
  })();

  if (!success) {
    logger.warn({ requestId }, "Deny action failed: request already processed");
    return;
  }

  // Update Slack approval message in channel
  if (req.slack_approval_channel_id && req.slack_approval_message_ts) {
    await notifier.updateApprovalMessage({
      channelId: req.slack_approval_channel_id,
      messageTs: req.slack_approval_message_ts,
      status: "denied",
      approverSlackUserId,
      deniedReason: reason,
    });
  }

  const teamRepo = new TeamRepository(db);
  const cachedTeam = teamRepo.getTeam(req.target_team_id);
  const teamName = cachedTeam ? cachedTeam.name : `Team ${req.target_team_id}`;

  // Notify requester
  if (requesterLink) {
    await notifier.notifyRequester({
      slackUserId: requesterLink.slack_user_id,
      teamName,
      status: "denied",
      deniedReason: reason,
    });

    // Post Audit Log
    await notifier.postAuditLog({
      requestId,
      slackUserId: requesterLink.slack_user_id,
      githubLogin: requesterLink.github_login,
      teamName,
      durationMinutes: req.duration_minutes,
      decisionMode: "manual",
      approverSlackUserId,
      status: "denied",
      deniedReason: reason,
    });
  }
}

export interface PolicyModalSubmissionContext {
  view: unknown;
  body: unknown;
  ack: unknown;
  db: Database.Database;
  notifier: SlackNotifier;
  githubClient: GitHubClient;
  client: unknown;
  orgContext: GitHubOrganizationContext;
}

/**
 * Handles policy Modal submissions.
 * Verifies authority, upserts policy, and logs the action.
 */
export async function handlePolicyModalSubmission(
  context: PolicyModalSubmissionContext,
): Promise<void> {
  const { view, body, ack, db, githubClient, client, orgContext } =
    context;
  const typedView = view as {
    state: {
      values: {
        target_team_block?: {
          policy_target_team_select?: {
            selected_option?: {
              value?: string;
            };
          };
        };
        requester_teams_block?: {
          policy_requester_teams_select?: {
            selected_options?: Array<{ value: string }>;
          };
        };
        max_duration_block?: {
          max_duration_input?: {
            value?: string;
          };
        };
        reason_required_block?: {
          reason_required_select?: {
            selected_option?: {
              value?: string;
            };
          };
        };
        enabled_block?: {
          enabled_select?: {
            selected_option?: {
              value?: string;
            };
          };
        };
      };
    };
  };
  const typedBody = body as { team: { id: string }; user: { id: string } };
  const typedAck = ack as (response?: unknown) => Promise<void>;
  const typedClient = client as {
    chat: {
      postMessage: (options: { channel: string; text: string }) => Promise<unknown>;
    };
  };

  // 1. Parse modal inputs
  const values = typedView.state.values;
  const targetTeamIdStr =
    values.target_team_block?.policy_target_team_select?.selected_option?.value;
  const requesterTeamOptions =
    values.requester_teams_block?.policy_requester_teams_select
      ?.selected_options || [];
  const maxDurationStr = values.max_duration_block?.max_duration_input?.value;
  const reasonRequiredStr =
    values.reason_required_block?.reason_required_select?.selected_option
      ?.value;
  const enabledStr =
    values.enabled_block?.enabled_select?.selected_option?.value;

  const targetTeamId = targetTeamIdStr ? Number(targetTeamIdStr) : null;
  const requesterTeamIds = requesterTeamOptions.map((opt: { value: string }) =>
    Number(opt.value),
  );
  const maxDurationMinutes = maxDurationStr ? Number(maxDurationStr) : null;
  const reasonRequired = reasonRequiredStr === "1";
  const enabled = enabledStr === "1";

  // Validate inputs
  if (
    !targetTeamId ||
    requesterTeamIds.length === 0 ||
    !maxDurationMinutes ||
    isNaN(maxDurationMinutes)
  ) {
    await typedAck({
      response_action: "errors",
      errors: {
        max_duration_block: "Please enter a valid max duration in minutes.",
      },
    });
    return;
  }

  // 2. Perform authorization check (User must be Owner/Maintainer of the target team)
  const slackUserId = typedBody.user.id;
  const identityRepo = new IdentityRepository(db);
  const link = identityRepo.getLinkBySlackUser(typedBody.team.id, slackUserId);

  if (!link) {
    await typedAck({
      response_action: "errors",
      errors: {
        target_team_block:
          "You must link your GitHub identity first via '/lightgrant link'.",
      },
    });
    return;
  }

  const authService = new AuthorizationService(githubClient);
  const authResult = await authService.verifyRequestDecisionAuthority({
    targetTeamId,
    githubUserId: link.github_user_id,
  });

  if (!authResult.authorized) {
    await typedAck({
      response_action: "errors",
      errors: {
        target_team_block: "Authorization failed: You must be a Maintainer of the target team.",
      },
    });
    return;
  }

  // Clear modal view
  await typedAck();

  const teamRepo = new TeamRepository(db);
  const slackWorkspaceId = typedBody.team.id;

  // 3. Upsert policy via PolicyService and insert Audit Log within transaction
  const policyService = new PolicyService(db);
  const auditRepo = new AuditRepository(db);
  const policyRepo = new PolicyRepository(db);

  const { version, snapshotHash } = db.transaction(() => {
    const res = policyService.upsertPolicy({
      targetTeamId,
      maxDurationMinutes,
      requesterTeamIds,
      reasonRequired,
      slackWorkspaceId,
      createdByIdentityId: link.id,
      githubOrgId: orgContext.organizationId,
    });

    if (!enabled) {
      policyRepo.disablePolicy(res.policyId, "disabled_by_owner");
    }

    // Write Audit Event
    auditRepo.writeEventTx({
      eventType: "policy_updated",
      actorType: "user",
      actorId: link.id,
      slackWorkspaceId,
      slackUserId,
      githubTeamId: targetTeamId,
      policyId: res.policyId,
      policyVersion: res.version,
      payloadJson: JSON.stringify({
        maxDurationMinutes,
        requesterTeamIds,
        reasonRequired,
        enabled,
        snapshotHash: res.snapshotHash,
      }),
    });

    return res;
  })();

  // 4. Send slack notification to audit channel
  const targetTeam = teamRepo.getTeam(targetTeamId);
  const targetTeamName = targetTeam
    ? targetTeam.name
    : `GitHub Team ${targetTeamId}`;

  try {
    await typedClient.chat.postMessage({
      channel: config.SLACK_AUDIT_CHANNEL_ID,
      text: `🔐 *Policy Updated*\n*Target Team*: ${targetTeamName}\n*Version*: ${version}\n*Max Duration*: ${maxDurationMinutes}m\n*Status*: ${
        enabled ? "Active" : "Disabled"
      }\n*Snapshot Hash*: \`${snapshotHash}\`\n*Updated By*: <@${slackUserId}> (\`${link.github_login}\`)`,
    });
  } catch (err) {
    logger.error({ err }, "Failed to post policy audit log notification");
  }
}
