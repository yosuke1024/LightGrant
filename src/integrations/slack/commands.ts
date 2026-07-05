import crypto from "crypto";
import Database from "better-sqlite3";
import { IdentityRepository } from "../../persistence/repositories/identity-repository.js";
import { OAuthStateRepository } from "../../persistence/repositories/oauth-state-repository.js";
import { TeamRepository } from "../../persistence/repositories/team-repository.js";
import { RequestRepository } from "../../persistence/repositories/request-repository.js";
import { AuditRepository } from "../../persistence/repositories/audit-repository.js";
import { generateStateToken } from "../../security/signed-state.js";
import { config } from "../../config.js";
import { PolicyRepository } from "../../persistence/repositories/policy-repository.js";
import { PolicyEvaluator } from "../../services/policy-evaluator.js";
import { SlackNotifier } from "../../services/slack-notifier.js";
import { GrantService } from "../../services/grant-service.js";
import { logger } from "../../logger.js";
import { GitHubAccessProvider } from "../github/github-client.js";

export interface CommandContext {
  command: unknown;
  ack: unknown;
  respond: unknown;
  client: unknown;
  db: Database.Database;
}

/**
 * Handles the main Slack Slash Command `/lightgrant`.
 * Redirects to GitHub OAuth connection if user is not linked,
 * otherwise opens the request modal.
 */
export async function handleLightGrantCommand(
  context: CommandContext,
): Promise<void> {
  const { command, ack, respond, client, db } = context;
  const typedCommand = command as {
    user_id: string;
    team_id: string;
    text?: string;
    trigger_id: string;
    channel_id: string;
  };
  const typedAck = ack as () => Promise<void>;
  const typedRespond = respond as (message: string | object) => Promise<unknown>;
  const typedClient = client as {
    views: {
      open: (options: { trigger_id: string; view: unknown }) => Promise<unknown>;
    };
    chat: {
      postEphemeral: (options: { channel: string; user: string; text: string }) => Promise<unknown>;
    };
  };

  await typedAck();

  const identityRepo = new IdentityRepository(db);
  const link = identityRepo.getLinkBySlackUser(
    typedCommand.team_id,
    typedCommand.user_id,
  );

  if (!link) {
    // Generate secure state and nonces
    const nonce = crypto.randomBytes(32).toString("hex");
    const nonceHash = crypto.createHash("sha256").update(nonce).digest("hex");
    const stateId = crypto.randomUUID();
    const expiresAtMs = Date.now() + 600000; // 10 minutes
    const expiresAt = new Date(expiresAtMs).toISOString();
    const timestamp = new Date().toISOString();

    const oauthStateRepo = new OAuthStateRepository(db);
    oauthStateRepo.createState(
      stateId,
      nonceHash,
      typedCommand.team_id,
      typedCommand.user_id,
      "command_request",
      typedCommand.trigger_id || null,
      expiresAt,
      timestamp,
    );

    const token = generateStateToken(
      typedCommand.team_id,
      typedCommand.user_id,
      nonce,
      expiresAtMs,
    );
    const authUrl = `${config.PUBLIC_BASE_URL}/auth/github/start?state=${token}`;

    await typedRespond({
      text: `GitHub account connection is required before requesting access.\n<${authUrl}|Connect GitHub>`,
      response_type: "ephemeral",
    });
  } else {
    const subCommand = typedCommand.text ? typedCommand.text.trim().toLowerCase() : "";

    if (subCommand === "policy") {
      // Open Policy Management Modal
      await typedClient.views.open({
        trigger_id: typedCommand.trigger_id,
        view: {
          type: "modal",
          callback_id: "policy_modal_skeleton",
          private_metadata: typedCommand.channel_id || "",
          title: {
            type: "plain_text",
            text: "Policy Management",
          },
          submit: {
            type: "plain_text",
            text: "Save Policy",
          },
          blocks: [
            {
              type: "input",
              block_id: "target_team_block",
              element: {
                type: "external_select",
                action_id: "policy_target_team_select",
                placeholder: {
                  type: "plain_text",
                  text: "Select GitHub Team to protect",
                },
                min_query_length: 0,
              },
              label: {
                type: "plain_text",
                text: "Target GitHub Team (To Protect)",
              },
            },
            {
              type: "input",
              block_id: "requester_teams_block",
              element: {
                type: "multi_external_select",
                action_id: "policy_requester_teams_select",
                placeholder: {
                  type: "plain_text",
                  text: "Select eligible requester teams",
                },
                min_query_length: 0,
              },
              label: {
                type: "plain_text",
                text: "Eligible Requester Teams (Auto-Approve)",
              },
            },
            {
              type: "input",
              block_id: "max_duration_block",
              element: {
                type: "plain_text_input",
                action_id: "max_duration_input",
                placeholder: {
                  type: "plain_text",
                  text: "e.g. 60",
                },
              },
              label: {
                type: "plain_text",
                text: "Maximum Duration (Minutes)",
              },
            },
            {
              type: "input",
              block_id: "reason_required_block",
              element: {
                type: "static_select",
                action_id: "reason_required_select",
                initial_option: {
                  text: { type: "plain_text", text: "Yes" },
                  value: "1",
                },
                options: [
                  {
                    text: { type: "plain_text", text: "Yes" },
                    value: "1",
                  },
                  {
                    text: { type: "plain_text", text: "No" },
                    value: "0",
                  },
                ],
              },
              label: {
                type: "plain_text",
                text: "Reason Required",
              },
            },
            {
              type: "input",
              block_id: "enabled_block",
              element: {
                type: "static_select",
                action_id: "enabled_select",
                initial_option: {
                  text: { type: "plain_text", text: "Enabled" },
                  value: "1",
                },
                options: [
                  {
                    text: { type: "plain_text", text: "Enabled" },
                    value: "1",
                  },
                  {
                    text: { type: "plain_text", text: "Disabled" },
                    value: "0",
                  },
                ],
              },
              label: {
                type: "plain_text",
                text: "Status",
              },
            },
          ],
        },
      });
      return;
    }

    if (subCommand === "audit") {
      const slackUserId = typedCommand.user_id;
      const isAdmin = config.ADMIN_SLACK_USER_IDS.includes(slackUserId);

      let isAuthorized = isAdmin;

      if (!isAuthorized && link) {
        const githubClient = new (
          await import("../github/github-client.js")
        ).GitHubClient({
          appId: config.GITHUB_APP_ID,
          privateKey: config.GITHUB_PRIVATE_KEY_BASE64,
          clientId: config.GITHUB_CLIENT_ID,
          clientSecret: config.GITHUB_CLIENT_SECRET,
          org: config.GITHUB_ORG,
        });

        const authService = new (
          await import("../../services/authorization-service.js")
        ).AuthorizationService(githubClient);

        const teamRepo = new TeamRepository(db);
        const activeTeams = teamRepo.listActiveTeams();

        for (const team of activeTeams) {
          const authResult = await authService.verifyRequestDecisionAuthority({
            targetTeamId: team.github_team_id,
            githubUserId: link.github_user_id,
          });
          if (authResult.authorized) {
            isAuthorized = true;
            break;
          }
        }
      }

      if (!isAuthorized) {
        await typedRespond({
          text: "🔒 *Unauthorized*: Only Workspace Admins or Team Maintainers/Org Owners can access audit logs.",
          response_type: "ephemeral",
        });
        return;
      }

      try {
        const auditExportService = new (
          await import("../../services/audit-export-service.js")
        ).AuditExportService(db);

        const { downloadUrl } = await auditExportService.exportToCsv({
          slackWorkspaceId: typedCommand.team_id,
          slackUserId,
          githubUserId: link ? link.github_user_id : undefined,
          isAdmin,
        });

        await typedRespond({
          text: `📥 *Audit Log Export Ready*\nYour export token has been generated. You can download the CSV log within the next 10 minutes:\n<${downloadUrl}|Download Audit Log CSV>\n_Note: This link is one-time use only._`,
          response_type: "ephemeral",
        });
      } catch (err) {
        logger.error({ err }, "Error generating audit export CSV");
        await typedRespond({
          text: "❌ *Failed*: An error occurred while generating the audit log export file.",
          response_type: "ephemeral",
        });
      }
      return;
    }

    // Open request modal
    await typedClient.views.open({
      trigger_id: typedCommand.trigger_id,
      view: {
        type: "modal",
        callback_id: "request_modal_skeleton",
        private_metadata: typedCommand.channel_id || "",
        title: {
          type: "plain_text",
          text: "LightGrant Request",
        },
        submit: {
          type: "plain_text",
          text: "Submit",
        },
        blocks: [
          {
            type: "input",
            block_id: "team_block",
            element: {
              type: "external_select",
              action_id: "team_select",
              placeholder: {
                type: "plain_text",
                text: "Select a GitHub Team",
              },
              min_query_length: 0,
            },
            label: {
              type: "plain_text",
              text: "Target GitHub Team",
            },
          },
          {
            type: "input",
            block_id: "duration_block",
            element: {
              type: "static_select",
              action_id: "duration_select",
              placeholder: {
                type: "plain_text",
                text: "Select duration",
              },
              options: [
                {
                  text: { type: "plain_text", text: "30 minutes" },
                  value: "30",
                },
                {
                  text: { type: "plain_text", text: "60 minutes" },
                  value: "60",
                },
                {
                  text: { type: "plain_text", text: "120 minutes" },
                  value: "120",
                },
                {
                  text: { type: "plain_text", text: "240 minutes" },
                  value: "240",
                },
                {
                  text: { type: "plain_text", text: "480 minutes" },
                  value: "480",
                },
              ],
              initial_option: {
                text: { type: "plain_text", text: "60 minutes" },
                value: "60",
              },
            },
            label: {
              type: "plain_text",
              text: "Duration",
            },
          },
          {
            type: "input",
            block_id: "reason_block",
            element: {
              type: "plain_text_input",
              action_id: "reason_input",
              multiline: true,
              placeholder: {
                type: "plain_text",
                text: "Describe why you need access to this team",
              },
            },
            label: {
              type: "plain_text",
              text: "Reason",
            },
          },
        ],
      },
    });
  }
}

/**
 * Handles dynamic search options load for target GitHub teams in Slack.
 */
export async function handleTeamOptionsLoad({
  options,
  ack,
  db,
}: {
  options: { value?: string };
  ack: unknown;
  db: Database.Database;
}): Promise<void> {
  const typedAck = ack as (response: unknown) => Promise<void>;
  const query = options.value || "";
  const teamRepo = new TeamRepository(db);
  const matched = teamRepo.searchTeams(query, 100);

  const slackOptions = matched.map((team) => {
    const isIdp = team.synchronized_flag === 1;
    return {
      text: {
        type: "plain_text",
        text: isIdp ? `${team.name} (IdP managed — unsupported)` : team.name,
      },
      value: String(team.github_team_id),
    };
  });

  await typedAck({ options: slackOptions });
}

export interface RequestModalSubmissionContext {
  view: unknown;
  body: unknown;
  ack: unknown;
  db: Database.Database;
  notifier: SlackNotifier;
  githubClient: GitHubAccessProvider;
  client: unknown;
}

/**
 * Handles target GitHub Team request modal submission.
 */
export async function handleRequestModalSubmission(
  context: RequestModalSubmissionContext,
): Promise<void> {
  const { view, body, ack, db, notifier, githubClient, client } = context;
  const typedView = view as {
    private_metadata?: string;
    state: {
      values: {
        team_block?: {
          team_select?: {
            selected_option?: {
              value?: string;
              text?: {
                text?: string;
              };
            };
          };
        };
        duration_block?: {
          duration_select?: {
            selected_option?: {
              value?: string;
            };
          };
        };
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
  const typedClient = client as {
    chat: {
      postEphemeral: (options: { channel: string; user: string; text: string }) => Promise<unknown>;
    };
  };

  const values = typedView.state.values;

  const selectedOption = values.team_block?.team_select?.selected_option;
  const durationOption =
    values.duration_block?.duration_select?.selected_option;
  const reasonVal = values.reason_block?.reason_input?.value;

  if (!selectedOption || !durationOption || !reasonVal) {
    await typedAck({
      response_action: "errors",
      errors: {
        team_block: "Please fill out all fields.",
      },
    });
    return;
  }

  const teamId = parseInt(selectedOption.value || "0", 10);
  const teamName = selectedOption.text?.text || "";
  const durationMinutes = parseInt(durationOption.value || "0", 10);
  const reason = reasonVal.trim();

  if (reason.length < 5 || reason.length > 500) {
    await typedAck({
      response_action: "errors",
      errors: {
        reason_block: "Reason must be between 5 and 500 characters.",
      },
    });
    return;
  }

  // Acknowledge submission to close modal
  await typedAck();

  const slackWorkspaceId = typedBody.user.team_id;
  const slackUserId = typedBody.user.id;

  const identityRepo = new IdentityRepository(db);
  const link = identityRepo.getLinkBySlackUser(slackWorkspaceId, slackUserId);
  if (!link) {
    logger.error(
      { slackUserId },
      "Request modal submission failed: identity link not found",
    );
    return;
  }

  const teamRepo = new TeamRepository(db);
  const cachedTeam = teamRepo.getTeam(teamId);
  if (!cachedTeam) {
    logger.error(
      { teamId },
      "Request modal submission failed: team not found in cache",
    );
    await typedAck();
    return;
  }

  if (cachedTeam.synchronized_flag === 1) {
    logger.warn(
      { teamId },
      "Request modal submission failed: team is IdP-synchronized",
    );
    await typedAck({
      response_action: "errors",
      errors: {
        team_block: "This team is IdP-synchronized and cannot be requested.",
      },
    });
    return;
  }

  const requestId = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const requestRepo = new RequestRepository(db);

  const sourceChannelId = typedView.private_metadata || "";

  // Verify requester's active organization membership before continuing
  let isOrgMember = false;
  try {
    const orgMembership = await githubClient.getOrganizationMembership(
      link.github_user_id,
    );
    isOrgMember = orgMembership ? orgMembership.state === "active" : false;
  } catch (err) {
    if ((err as Error).name !== "GitHubNotFoundError") {
      throw err;
    }
  }

  if (!isOrgMember) {
    logger.warn(
      { requesterGithubUserId: link.github_user_id },
      "Request modal submission failed: requester is not an active organization member",
    );
    try {
      await typedClient.chat.postEphemeral({
        channel: sourceChannelId || slackUserId,
        user: slackUserId,
        text: "Your connected GitHub account is not an active member of this organization.\nAsk an organization owner to complete your organization invitation first.",
      });
    } catch (err) {
      logger.error({ err }, "Failed to send organization invitation alert");
    }
    return;
  }

  // Policy Evaluation & Auto-Approval Check using PolicyEvaluator
  const policyRepo = new PolicyRepository(db);
  const evaluator = new PolicyEvaluator(policyRepo, githubClient);

  const evalResult = await evaluator.evaluate({
    requesterGithubUserId: link.github_user_id,
    targetTeamId: teamId,
    durationMinutes,
    reason,
  });

  // Write policy.evaluated audit event in transaction
  db.transaction(() => {
    const auditRepo = new AuditRepository(db);
    auditRepo.writeEventTx({
      eventType: "policy.evaluated",
      actorType: "user",
      actorId: link.id,
      slackWorkspaceId,
      slackUserId,
      githubOrgId: cachedTeam.github_org_id,
      githubUserId: link.github_user_id,
      githubTeamId: teamId,
      accessRequestId: requestId,
      payloadJson: JSON.stringify({
        selected_policy_id: evalResult.selectedPolicyId,
        selected_policy_version: evalResult.selectedPolicyVersion,
        selected_policy_snapshot_hash: evalResult.selectedPolicySnapshotHash,
        matched_requester_team_ids: evalResult.matchedRequesterTeamIds,
        evaluated_policy_results: evalResult.evaluatedPolicies.map((p) => ({
          policy_id: p.policyId,
          version: p.version,
          matched: p.matched,
          reason_for_outcome: p.reasonForOutcome,
        })),
        is_auto_approved: evalResult.matched,
      }),
    });
  })();

  if (evalResult.matched && evalResult.selectedPolicyId) {
    logger.info(
      {
        requestId,
        teamId,
        durationMinutes,
        policyId: evalResult.selectedPolicyId,
      },
      "Request met auto-approval criteria. Initiating auto-grant flow.",
    );

    // Create request immediately in pending state and write Audit Log in a transaction
    db.transaction(() => {
      requestRepo.createRequest({
        id: requestId,
        slackWorkspaceId,
        githubOrgId: cachedTeam.github_org_id,
        requesterIdentityId: link.id,
        targetTeamId: teamId,
        durationMinutes,
        reason,
        decisionStatus: "pending",
        requestedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      const auditRepo = new AuditRepository(db);
      auditRepo.writeEventTx({
        eventType: "access_requested",
        actorType: "user",
        actorId: link.id,
        slackWorkspaceId,
        slackUserId,
        githubOrgId: cachedTeam.github_org_id,
        githubUserId: link.github_user_id,
        githubTeamId: teamId,
        accessRequestId: requestId,
        payloadJson: JSON.stringify({
          durationMinutes,
          reason,
          decisionMode: "auto",
        }),
      });
    })();

    const grantService = new GrantService(db);
    try {
      grantService.createGrantIntentTx({
        requestId,
        decisionMode: "auto",
        matchedPolicyId: evalResult.selectedPolicyId,
        matchedPolicyVersion: evalResult.selectedPolicyVersion || 1,
      });
    } catch (err) {
      logger.error(
        { err, requestId },
        "Auto-approval grant intent transaction failed",
      );
    }

    return;
  }

  // Otherwise, fall back to manual approval flow
  db.transaction(() => {
    requestRepo.createRequest({
      id: requestId,
      slackWorkspaceId,
      githubOrgId: cachedTeam.github_org_id,
      requesterIdentityId: link.id,
      targetTeamId: teamId,
      durationMinutes,
      reason,
      decisionStatus: "pending",
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    const auditRepo = new AuditRepository(db);
    auditRepo.writeEventTx({
      eventType: "access_requested",
      actorType: "user",
      actorId: link.id,
      slackWorkspaceId,
      slackUserId,
      githubOrgId: cachedTeam.github_org_id,
      githubUserId: link.github_user_id,
      githubTeamId: teamId,
      accessRequestId: requestId,
      payloadJson: JSON.stringify({
        durationMinutes,
        reason,
        decisionMode: "manual",
      }),
    });
  })();

  try {
    const { channelId, messageTs } = await notifier.postManualApproval({
      requestId,
      slackUserId,
      githubLogin: link.github_login,
      teamName,
      durationMinutes,
      reason,
    });

    requestRepo.updateSlackMessageInfo(requestId, channelId, messageTs);
  } catch (error) {
    logger.error({ error, requestId }, "Failed to post Slack approval message");
  }
}
