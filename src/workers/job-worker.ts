import Database from "better-sqlite3";
import { determineMembershipOrigin } from "../domain/membership.js";
import {
  JobRepository,
  DbJob,
} from "../persistence/repositories/job-repository.js";
import { GrantRepository } from "../persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../persistence/repositories/identity-repository.js";
import { RequestRepository } from "../persistence/repositories/request-repository.js";
import { SlackNotifier } from "../services/slack-notifier.js";
import { logger } from "../logger.js";
import { config } from "../config.js";
import { AuditRepository } from "../persistence/repositories/audit-repository.js";
import { GitHubOrganizationContext } from "../domain/github-organization-context.js";
import crypto from "crypto";
import { GitHubAccessProvider } from "../integrations/github/github-client.js";

export class JobWorker {
  private jobRepo: JobRepository;
  private grantRepo: GrantRepository;
  private identityRepo: IdentityRepository;
  private auditRepo: AuditRepository;
  private isRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private workerId: string;
  private lastWebhookRecoveryAt = 0;

  constructor(
    private db: Database.Database,
    private githubClient: GitHubAccessProvider,
    private notifier: SlackNotifier,
    private orgContext: GitHubOrganizationContext,
  ) {
    this.jobRepo = new JobRepository(db);
    this.grantRepo = new GrantRepository(db);
    this.identityRepo = new IdentityRepository(db);
    this.auditRepo = new AuditRepository(db);
    this.workerId = `worker-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Start the background job worker polling loop.
   */
  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info({ workerId: this.workerId }, "JobWorker started");
    this.poll();
  }

  /**
   * Stop the background job worker polling loop.
   */
  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    logger.info({ workerId: this.workerId }, "JobWorker stopped");
  }

  private poll(): void {
    if (!this.isRunning) return;

    const pollIntervalMs = (config.JOB_POLL_INTERVAL_SECONDS || 5) * 1000;

    // Run execution cycle
    this.runCycle()
      .catch((err) => {
        logger.error({ err }, "Error in JobWorker execution cycle");
      })
      .finally(() => {
        if (this.isRunning) {
          this.timer = setTimeout(() => this.poll(), pollIntervalMs);
        }
      });
  }

  private recoverLeasedNotifications(): void {
    const timeoutThreshold = new Date(Date.now() - 300 * 1000).toISOString();
    const result = this.db
      .prepare(
        `
      UPDATE notification_deliveries
      SET status = 'failed',
          updated_at = ?
      WHERE status = 'sending' AND updated_at < ?
    `,
      )
      .run(new Date().toISOString(), timeoutThreshold);

    if (result.changes > 0) {
      logger.warn(
        { count: result.changes },
        "Recovered stuck 'sending' notification deliveries",
      );
    }
  }

  private recoverStaleWebhookDeliveries(): void {
    const now = new Date().toISOString();
    const nowMs = Date.now();
    
    // Run every 60 seconds (1 minute interval)
    if (nowMs - this.lastWebhookRecoveryAt < 60 * 1000) {
      return;
    }
    this.lastWebhookRecoveryAt = nowMs;

    try {
      const staleDeliveries = this.db
        .prepare(
          `
        SELECT delivery_id, attempt_count FROM webhook_deliveries
        WHERE provider = 'github'
          AND status = 'processing'
          AND lease_expires_at <= ?
      `,
        )
        .all(now) as { delivery_id: string; attempt_count: number }[];

      if (staleDeliveries.length === 0) {
        return;
      }

      logger.warn(
        { count: staleDeliveries.length },
        "Found stale webhook deliveries processing leases. Recovering...",
      );

      for (const delivery of staleDeliveries) {
        this.db.transaction(() => {
          // 1. Mark status as failed due to lease expiration
          this.db
            .prepare(
              `
            UPDATE webhook_deliveries
            SET status = 'failed',
                last_error = 'processing_lease_expired',
                lease_expires_at = NULL
            WHERE provider = 'github' AND delivery_id = ?
          `,
            )
            .run(delivery.delivery_id);

          // 2. Audit: processing_lease_expired
          this.auditRepo.writeEventTx({
            eventType: "webhook.processing_lease_expired",
            actorType: "system",
            actorId: this.workerId,
            githubOrgId: this.orgContext.organizationId,
            payloadJson: JSON.stringify({
              deliveryId: delivery.delivery_id,
              attemptCount: delivery.attempt_count,
            }),
          });

          if (delivery.attempt_count <= 10) {
            // 3. Enqueue reprocess job
            this.jobRepo.createJob({
              id: crypto.randomUUID(),
              type: "reprocess_webhook",
              payloadJson: JSON.stringify({
                deliveryId: delivery.delivery_id,
              }),
              runAfter: now,
            });

            // 4. Audit: redelivery_recovered
            this.auditRepo.writeEventTx({
              eventType: "webhook.redelivery_recovered",
              actorType: "system",
              actorId: this.workerId,
              githubOrgId: this.orgContext.organizationId,
              payloadJson: JSON.stringify({
                deliveryId: delivery.delivery_id,
                attemptCount: delivery.attempt_count,
              }),
            });

            logger.info(
              { deliveryId: delivery.delivery_id, attemptCount: delivery.attempt_count },
              "Enqueued webhook reprocess job after lease expired",
            );
          } else {
            // 5. Audit: permanently_failed
            this.auditRepo.writeEventTx({
              eventType: "webhook.permanently_failed",
              actorType: "system",
              actorId: this.workerId,
              githubOrgId: this.orgContext.organizationId,
              payloadJson: JSON.stringify({
                deliveryId: delivery.delivery_id,
                reason: "Max retry limit reached (10)",
              }),
            });

            logger.error(
              { deliveryId: delivery.delivery_id, attemptCount: delivery.attempt_count },
              "Webhook delivery permanently failed: retry limit reached",
            );
          }
        })();
      }
    } catch (err) {
      logger.error({ err }, "Error recovering stale webhook deliveries");
    }
  }

  private async runCycle(): Promise<void> {
    this.recoverLeasedNotifications();
    this.recoverStaleWebhookDeliveries();

    // Acquire a batch of queued runnable jobs (limit = 5, leaseDurationSeconds = 60)
    const jobs = this.jobRepo.acquireNextJobs(this.workerId, 5, 60);
    if (jobs.length === 0) return;

    logger.debug({ count: jobs.length }, "Acquired jobs for processing");

    for (const job of jobs) {
      try {
        await this.executeJob(job);
      } catch (err) {
        logger.error({ jobId: job.id, err }, "Job execution failed");
        await this.handleJobFailure(job, err);
      }
    }
  }

  private async executeJob(job: DbJob): Promise<void> {
    logger.info({ jobId: job.id, type: job.type }, "Starting job execution");

    if (job.type === "grant_access") {
      const { grantId } = JSON.parse(job.payload_json);
      await this.handleGrantAccess(job, grantId);
    } else if (job.type === "revoke_access") {
      const { grantId } = JSON.parse(job.payload_json);
      const grant = this.grantRepo.getGrant(grantId);
      if (grant) {
        const revocationService = new (
          await import("../services/revocation-service.js")
        ).RevocationService(this.db, this.githubClient, this.notifier);
        await revocationService.revoke(grant);

        const freshGrant = this.grantRepo.getGrant(grantId);
        if (freshGrant && freshGrant.status === "revoke_failed") {
          throw new Error(freshGrant.last_error_message || "Revocation failed");
        }
      }
      this.jobRepo.completeJob(job.id);
    } else if (job.type === "validate_policy_authority") {
      await this.handleValidatePolicyAuthority(job);
    } else if (job.type === "notify_request_result" || job.type === "notify_revocation_result") {
      await this.handleNotifyRequestResult(job);
    } else if (job.type === "post_audit_notification") {
      await this.handlePostAuditNotification(job);
    } else if (job.type === "reprocess_webhook") {
      const { deliveryId } = JSON.parse(job.payload_json);
      const { WebhookService } = await import("../services/webhook-service.js");
      const webhookService = new WebhookService(this.db, this.orgContext, this.githubClient);
      const success = await webhookService.reprocessDelivery(deliveryId);
      if (!success) {
        throw new Error(`Reprocessing failed for webhook delivery ${deliveryId}`);
      }
      this.jobRepo.completeJob(job.id);
    } else {
      // Unsupported job type, fail it
      logger.warn({ jobId: job.id, type: job.type }, "Unsupported job type");
      this.jobRepo.failJob(job.id, `Unsupported job type: ${job.type}`);
    }
  }

  private async handleValidatePolicyAuthority(job: DbJob): Promise<void> {
    const policyRepo = new (
      await import("../persistence/repositories/policy-repository.js")
    ).PolicyRepository(this.db);
    const teamRepo = new (
      await import("../persistence/repositories/team-repository.js")
    ).TeamRepository(this.db);
    const authService = new (
      await import("../services/authorization-service.js")
    ).AuthorizationService(this.githubClient);

    const activePolicies = policyRepo.listAllActivePolicies();
    logger.info(
      { count: activePolicies.length },
      "Validating policy authorities",
    );

    for (const policy of activePolicies) {
      try {
        const authResult = await authService.verifyRequestDecisionAuthority({
          targetTeamId: policy.target_team_id,
          githubUserId: policy.owner_github_user_id,
        });

        if (!authResult.authorized) {
          logger.warn(
            { policyId: policy.id, targetTeamId: policy.target_team_id },
            "Policy owner lost Maintainer authority. Disabling policy.",
          );

          // Disable policy in DB
          policyRepo.disablePolicy(policy.id, "owner_no_longer_maintainer");

          // Resolve owner Slack user mapping
          const ownerLink = this.identityRepo.getLink(policy.owner_identity_id);
          const ownerSlackUserId = ownerLink
            ? ownerLink.slack_user_id
            : "unknown";
          const ownerGithubLogin = ownerLink
            ? ownerLink.github_login
            : "unknown";

          // Resolve team name
          const cachedTeam = teamRepo.getTeam(policy.target_team_id);
          const targetTeamName = cachedTeam
            ? cachedTeam.name
            : `GitHub Team ${policy.target_team_id}`;

          // Notify Slack audit log
          await this.notifier.postPolicyDisabledAlert({
            targetTeamName,
            ownerSlackUserId,
            ownerGithubLogin,
            disabledReason:
              "Owner is no longer a Maintainer of the target team",
          });
        }
      } catch (err) {
        logger.error(
          { policyId: policy.id, err },
          "Failed to validate specific policy authority",
        );
      }
    }

    this.jobRepo.completeJob(job.id);
  }

  private async handleGrantAccess(job: DbJob, grantId: string): Promise<void> {
    const grant = this.grantRepo.getGrant(grantId);
    if (!grant) {
      throw new Error(`Grant ${grantId} not found in database`);
    }

    // Check if the grant is already in a completed state
    if (grant.status === "active" || grant.status === "already_present") {
      logger.info(
        { grantId, status: grant.status },
        "Grant is already satisfied, completing job",
      );
      this.jobRepo.completeJob(job.id);
      return;
    }

    // Try to find the requester identity details for notifications
    const link = this.identityRepo.getLinkByGitHubUserGlobal(
      grant.github_user_id,
    );
    const slackUserId = link ? link.slack_user_id : null;

    // Fetch team details for notification from the grants cache
    const teamRepo = new (
      await import("../persistence/repositories/team-repository.js")
    ).TeamRepository(this.db);
    const cachedTeam = teamRepo.getTeam(grant.target_team_id);
    const teamName = cachedTeam
      ? cachedTeam.name
      : `GitHub Team ${grant.target_team_id}`;

    // 1. Live Org Membership Verification
    logger.debug(
      { githubUserId: grant.github_user_id },
      "Verifying live organization membership",
    );
    let orgMembership: { state?: string; role?: string } | null = null;
    try {
      orgMembership = await this.githubClient.getOrganizationMembership(
        grant.github_user_id,
      );
    } catch (err) {
      if ((err as Error).name === "GitHubNotFoundError") {
        // User not in org, fail permanently
        await this.markGrantPermanentlyFailed(
          job.id,
          grantId,
          "organization_membership_missing",
          `User is not a member of the GitHub Organization.`,
          slackUserId,
          teamName,
        );
        return;
      }
      throw err; // Transient error
    }

    if (orgMembership?.state !== "active") {
      await this.markGrantPermanentlyFailed(
        job.id,
        grantId,
        "organization_membership_inactive",
        `Requester organization membership state is not active (state: ${orgMembership?.state || "unknown"}).`,
        slackUserId,
        teamName,
      );
      return;
    }

    const auditRepo = new (
      await import("../persistence/repositories/audit-repository.js")
    ).AuditRepository(this.db);
    const timestamp = new Date().toISOString();

    let isRetry = true;

    // 2.0. Reactivation Check
    if (grant.membership_mutation_state === "reactivation_required") {
      isRetry = false;
      logger.info(
        { grantId },
        "Reactivation required, performing live verification check",
      );
      let currentRole: string | null = null;
      try {
        const membership = await this.githubClient.getTeamMembership(
          grant.target_team_id,
          grant.github_user_id,
        );
        currentRole = membership ? membership.role : null;
      } catch (err) {
        if ((err as Error).name !== "GitHubNotFoundError") {
          throw err;
        }
      }

      if (currentRole === "member") {
        logger.info(
          { grantId },
          "Live membership is already member during reactivation",
        );

        const requests = this.grantRepo.listGrantRequests(grantId);
        const requestRepo = new (
          await import("../persistence/repositories/request-repository.js")
        ).RequestRepository(this.db);
        const maxDuration =
          requests.length > 0
            ? Math.max(
                ...requests.map((r) => {
                  const req = requestRepo.getRequest(r.access_request_id);
                  return req ? req.duration_minutes : 60;
                }),
              )
            : 60;

        // A reactivated grant may wrap a membership the app never created.
        // Re-derive the origin instead of assuming app-created, or the next
        // expiry would remove a permanent member from the team.
        const origin = determineMembershipOrigin({
          mutationState: grant.membership_mutation_state,
          membershipCreatedByApp: grant.membership_created_by_app === 1,
          observedRole: "member",
        });

        this.db.transaction(() => {
          this.grantRepo.updateMutationState(grantId, {
            membershipMutationState: "membership_confirmed",
            membershipAddLastVerifiedAt: timestamp,
          });
          if (origin === "preexisting") {
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              "already_present",
              0,
              "member",
            );
          } else {
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              "active",
              1,
              null,
            );
          }
          this.jobRepo.completeJob(job.id);

          auditRepo.writeEventTx({
            eventType: "grant.reactivated",
            actorType: "system",
            githubOrgId: grant.github_org_id,
            githubUserId: grant.github_user_id,
            githubTeamId: grant.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              reason: "membership_already_member_during_reactivate",
              role: "member",
              origin,
            }),
          });

          // Enqueue Slack notification job
          this.jobRepo.createJob({
            id: crypto.randomUUID(),
            type: "notify_request_result",
            payloadJson: JSON.stringify({
              requestId: grantId,
              slackUserId,
              teamName,
              status: "approved",
              durationMinutes: maxDuration,
            }),
            runAfter: new Date().toISOString(),
          });
        })();
        return;
      } else if (currentRole === "maintainer") {
        logger.warn(
          { grantId },
          "Live membership is maintainer during reactivation. Protecting and completing.",
        );

        const origin = determineMembershipOrigin({
          mutationState: grant.membership_mutation_state,
          membershipCreatedByApp: grant.membership_created_by_app === 1,
          observedRole: "maintainer",
        });

        this.db.transaction(() => {
          if (origin === "preexisting") {
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              "already_present",
              0,
              "maintainer",
            );
          } else {
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              "active",
              1,
              null,
            );
            this.grantRepo.updateGrantStatus(
              grantId,
              "active",
              null,
              "membership_elevated",
              "User was elevated to Maintainer of the team on GitHub.",
            );
            this.grantRepo.updateMutationState(grantId, {
              membershipMutationState: "membership_confirmed",
              membershipAddLastVerifiedAt: timestamp,
            });

            auditRepo.writeEventTx({
              eventType: "grant.membership_origin_preserved",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                grant_id: grantId,
                observed_role: "maintainer",
                membership_created_by_app: true,
                mutation_state: grant.membership_mutation_state,
                action: "preserved_app_created_origin",
              }),
            });

            auditRepo.writeEventTx({
              eventType: "grant.membership_elevated",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                observed_role: "maintainer",
                context: "reactivate_recheck",
              }),
            });
          }
          this.jobRepo.completeJob(job.id);
        })();
        return;
      } else if (!currentRole) {
        logger.info(
          { grantId },
          "Membership is absent during reactivation. Starting add mutation flow.",
        );
        const operationId = crypto.randomUUID();
        this.db.transaction(() => {
          this.grantRepo.updateMutationState(grantId, {
            membershipMutationState: "add_intent_recorded",
            membershipAddAttemptedAt: timestamp,
            membershipAddOperationId: operationId,
          });

          auditRepo.writeEventTx({
            eventType: "grant.started",
            actorType: "system",
            githubOrgId: grant.github_org_id,
            githubUserId: grant.github_user_id,
            githubTeamId: grant.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              membership_mutation_state: "add_intent_recorded",
              operation_id: operationId,
              effective_expires_at: grant.effective_expires_at,
              context: "reactivation",
            }),
          });
        })();

        const freshGrant = this.grantRepo.getGrant(grantId)!;
        grant.membership_mutation_state = freshGrant.membership_mutation_state;
        grant.membership_add_operation_id =
          freshGrant.membership_add_operation_id;
      } else {
        logger.error(
          { grantId, currentRole },
          "Live membership is in a pending/invalid state. Failing permanently.",
        );
        await this.markGrantPermanentlyFailed(
          job.id,
          grantId,
          "membership_pending_or_invalid",
          `GitHub membership state is invalid or pending: ${currentRole}`,
          slackUserId,
          teamName,
        );
        return;
      }
    }

    // 2. Initial check for not_started
    if (grant.membership_mutation_state === "not_started") {
      isRetry = false;
      logger.debug(
        {
          targetTeamId: grant.target_team_id,
          githubUserId: grant.github_user_id,
        },
        "Checking initial preexisting team membership",
      );
      let preexistingRole: string | null = null;
      try {
        const membership = await this.githubClient.getTeamMembership(
          grant.target_team_id,
          grant.github_user_id,
        );
        preexistingRole = membership ? membership.role : null;
      } catch (err) {
        if ((err as Error).name !== "GitHubNotFoundError") {
          throw err;
        }
      }

      if (preexistingRole === "member" || preexistingRole === "maintainer") {
        logger.info(
          { grantId, preexistingRole },
          "Requester already has membership in target team (preexisting)",
        );
        this.db.transaction(() => {
          this.grantRepo.updateGrantStatusAndMembership(
            grantId,
            "already_present",
            0,
            preexistingRole,
          );
          this.jobRepo.completeJob(job.id);

          auditRepo.writeEventTx({
            eventType: "grant.already_present",
            actorType: "system",
            githubOrgId: grant.github_org_id,
            githubUserId: grant.github_user_id,
            githubTeamId: grant.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              preexisting_role: preexistingRole,
              membership_created_by_app: false,
            }),
          });

          // Enqueue Slack notification job
          this.jobRepo.createJob({
            id: crypto.randomUUID(),
            type: "notify_request_result",
            payloadJson: JSON.stringify({
              requestId: grantId,
              slackUserId,
              teamName,
              status: "already_present",
              durationMinutes: 0,
            }),
            runAfter: new Date().toISOString(),
          });
        })();
        return;
      }

      // Record intent to add
      const operationId = crypto.randomUUID();
      this.db.transaction(() => {
        this.grantRepo.updateMutationState(grantId, {
          membershipMutationState: "add_intent_recorded",
          membershipAddAttemptedAt: timestamp,
          membershipAddOperationId: operationId,
        });

        auditRepo.writeEventTx({
          eventType: "grant.started",
          actorType: "system",
          githubOrgId: grant.github_org_id,
          githubUserId: grant.github_user_id,
          githubTeamId: grant.target_team_id,
          grantId,
          payloadJson: JSON.stringify({
            membership_mutation_state: "add_intent_recorded",
            operation_id: operationId,
            effective_expires_at: grant.effective_expires_at,
          }),
        });
      })();

      // update local grant ref
      const freshGrant = this.grantRepo.getGrant(grantId)!;
      grant.membership_mutation_state = freshGrant.membership_mutation_state;
      grant.membership_add_operation_id =
        freshGrant.membership_add_operation_id;
    }

    // 3. Retry check (if state is add_intent_recorded or add_request_sent)
    if (
      isRetry &&
      (grant.membership_mutation_state === "add_intent_recorded" ||
        grant.membership_mutation_state === "add_request_sent")
    ) {
      logger.debug(
        {
          targetTeamId: grant.target_team_id,
          githubUserId: grant.github_user_id,
        },
        "Verifying live team membership for recovery",
      );
      let preexistingRole: string | null = null;
      try {
        const membership = await this.githubClient.getTeamMembership(
          grant.target_team_id,
          grant.github_user_id,
        );
        preexistingRole = membership ? membership.role : null;
      } catch (err) {
        if ((err as Error).name !== "GitHubNotFoundError") {
          throw err;
        }
      }

      if (preexistingRole === "member" || preexistingRole === "maintainer") {
        logger.info(
          { grantId, preexistingRole },
          "Recovered membership from previous failed/timedout attempt",
        );

        if (preexistingRole === "member") {
          const requests = this.grantRepo.listGrantRequests(grantId);
          const requestRepo = new RequestRepository(this.db);
          const maxDuration =
            requests.length > 0
              ? Math.max(
                  ...requests.map((r) => {
                    const req = requestRepo.getRequest(r.access_request_id);
                    return req ? req.duration_minutes : 60;
                  }),
                )
              : 60;

          this.db.transaction(() => {
            this.grantRepo.updateMutationState(grantId, {
              membershipMutationState: "membership_confirmed",
              membershipAddLastVerifiedAt: timestamp,
            });
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              "active",
              1,
              null,
            );
            this.jobRepo.completeJob(job.id);

            auditRepo.writeEventTx({
              eventType: "grant.recovered_after_uncertain_result",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                operation_id: grant.membership_add_operation_id,
                previous_mutation_state: grant.membership_mutation_state,
                observed_role: preexistingRole,
                recovery_reason: "membership_present_after_timeout",
              }),
            });

            // Enqueue Slack notification job
            this.jobRepo.createJob({
              id: crypto.randomUUID(),
              type: "notify_request_result",
              payloadJson: JSON.stringify({
                requestId: grantId,
                slackUserId,
                teamName,
                status: "approved",
                durationMinutes: maxDuration,
              }),
              runAfter: new Date().toISOString(),
            });
          })();
        } else {
          // elevated to maintainer
          this.db.transaction(() => {
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              "active",
              1,
              null,
            );
            this.grantRepo.updateGrantStatus(
              grantId,
              "active",
              null,
              "membership_elevated",
              "User was elevated to Maintainer of the team on GitHub.",
            );
            this.jobRepo.completeJob(job.id);

            auditRepo.writeEventTx({
              eventType: "grant.recovered_after_uncertain_result",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                operation_id: grant.membership_add_operation_id,
                previous_mutation_state: grant.membership_mutation_state,
                observed_role: "maintainer",
                recovery_reason:
                  "membership_present_as_maintainer_after_timeout",
              }),
            });

            // Record grant.membership_elevated
            auditRepo.writeEventTx({
              eventType: "grant.membership_elevated",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                observed_role: "maintainer",
                context: "recovery_recheck",
              }),
            });
          })();
        }
        return;
      }
    } else if (grant.membership_mutation_state === "membership_confirmed") {
      const hasActiveReq = this.grantRepo.hasActiveRequests(
        grantId,
        new Date().toISOString(),
      );
      if (grant.status === "active" && hasActiveReq) {
        logger.debug(
          { grantId },
          "Grant is already active with active requests. Short-circuiting.",
        );
        this.jobRepo.completeJob(job.id);
        return;
      }

      logger.info(
        { grantId, status: grant.status, hasActiveReq },
        "Confirmed state but status not active or has no active requests. Performing live validation.",
      );
      let currentRole: string | null = null;
      try {
        const membership = await this.githubClient.getTeamMembership(
          grant.target_team_id,
          grant.github_user_id,
        );
        currentRole = membership ? membership.role : null;
      } catch (err) {
        if ((err as Error).name !== "GitHubNotFoundError") {
          throw err;
        }
      }

      if (currentRole === "member") {
        this.db.transaction(() => {
          this.grantRepo.updateGrantStatusAndMembership(
            grantId,
            "active",
            1,
            null,
          );
          this.jobRepo.completeJob(job.id);
        })();
        return;
      } else if (currentRole === "maintainer") {
        const origin = determineMembershipOrigin({
          mutationState: grant.membership_mutation_state,
          membershipCreatedByApp: grant.membership_created_by_app === 1,
          observedRole: "maintainer",
        });

        this.db.transaction(() => {
          if (origin === "preexisting") {
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              "already_present",
              0,
              "maintainer",
            );
          } else {
            const nextStatus = grant.status === "revoke_failed" ? "revoke_failed" : "active";
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              nextStatus,
              1,
              null,
            );
            this.grantRepo.updateGrantStatus(
              grantId,
              nextStatus,
              null,
              "membership_elevated",
              "User was elevated to Maintainer of the team on GitHub.",
            );
            this.grantRepo.updateMutationState(grantId, {
              membershipMutationState: "membership_confirmed",
              membershipAddLastVerifiedAt: new Date().toISOString(),
            });

            auditRepo.writeEventTx({
              eventType: "grant.membership_origin_preserved",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                grant_id: grantId,
                observed_role: "maintainer",
                membership_created_by_app: true,
                mutation_state: grant.membership_mutation_state,
                action: "preserved_app_created_origin",
              }),
            });

            auditRepo.writeEventTx({
              eventType: "grant.membership_elevated",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                observed_role: "maintainer",
                context: "confirmed_recheck",
              }),
            });
          }
          this.jobRepo.completeJob(job.id);
        })();
        return;
      } else {
        logger.warn(
          { grantId },
          "Membership is missing even though mutation state was membership_confirmed. Resetting to not_started.",
        );
        this.db.transaction(() => {
          this.grantRepo.updateMutationState(grantId, {
            membershipMutationState: "not_started",
          });
        })();
        throw new Error(
          "Membership missing for confirmed grant. Resetting to not_started.",
        );
      }
    }

    // 4. Mutate: Add Member to GitHub Team
    logger.info(
      {
        targetTeamId: grant.target_team_id,
        githubUserId: grant.github_user_id,
      },
      "Adding member to GitHub team",
    );

    // Update state to add_request_sent before calling API
    this.grantRepo.updateMutationState(grantId, {
      membershipMutationState: "add_request_sent",
      membershipAddAttemptedAt: timestamp,
    });

    try {
      await this.githubClient.addTeamMember(
        grant.target_team_id,
        grant.github_user_id,
      );
    } catch (err) {
      if ((err as Error).name === "GitHubIdpSyncError") {
        logger.warn(
          { grantId, err },
          "Detected IdP-synchronized team membership error. Failing permanently.",
        );

        const teamRepo = new (
          await import("../persistence/repositories/team-repository.js")
        ).TeamRepository(this.db);
        teamRepo.setSynchronizedFlag(grant.target_team_id, true);

        this.db.transaction(() => {
          this.grantRepo.updateGrantStatus(
            grantId,
            "grant_failed",
            null,
            "github_team_sync_managed",
            "This team is synchronized with an identity provider and members cannot be manually managed.",
          );
          this.jobRepo.failJob(
            job.id,
            "github_team_sync_managed: IdP synchronized team",
          );

          auditRepo.writeEventTx({
            eventType: "team.unsupported_idp_sync",
            actorType: "system",
            githubOrgId: grant.github_org_id,
            githubUserId: grant.github_user_id,
            githubTeamId: grant.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              reason: "detected_during_grant_attempt",
            }),
          });

          auditRepo.writeEventTx({
            eventType: "grant.failed",
            actorType: "system",
            githubOrgId: grant.github_org_id,
            githubUserId: grant.github_user_id,
            githubTeamId: grant.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              error_code: "github_team_sync_managed",
              error_message: (err as Error).message,
              retryable: false,
            }),
          });

          // Enqueue Notification Job inside transaction
          this.jobRepo.createJob({
            id: crypto.randomUUID(),
            type: "notify_request_result",
            payloadJson: JSON.stringify({
              requestId: grantId,
              slackUserId,
              teamName,
              status: "grant_failed",
              durationMinutes: 0,
            }),
            runAfter: new Date().toISOString(),
          });
        })();
        return;
      }

      logger.error(
        { err, grantId },
        "Failed to add team member, checking if it was actually created",
      );

      // Verification attempt after error
      let checkRole: string | null = null;
      try {
        const checkMembership = await this.githubClient.getTeamMembership(
          grant.target_team_id,
          grant.github_user_id,
        );
        checkRole = checkMembership ? checkMembership.role : null;
      } catch (checkErr) {
        logger.error(
          { checkErr },
          "Failed to check membership after API timeout",
        );
        throw err; // Rethrow original error to trigger retry
      }

      if (checkRole === "member") {
        this.db.transaction(() => {
          this.grantRepo.updateMutationState(grantId, {
            membershipMutationState: "membership_confirmed",
            membershipAddLastVerifiedAt: new Date().toISOString(),
          });
          this.grantRepo.updateGrantStatusAndMembership(
            grantId,
            "active",
            1,
            null,
          );
          this.jobRepo.completeJob(job.id);

          auditRepo.writeEventTx({
            eventType: "grant.recovered_after_uncertain_result",
            actorType: "system",
            githubOrgId: grant.github_org_id,
            githubUserId: grant.github_user_id,
            githubTeamId: grant.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              operation_id: grant.membership_add_operation_id,
              previous_mutation_state: "add_request_sent",
              observed_role: "member",
              recovery_reason: "membership_present_after_timeout",
            }),
          });
        })();
        return;
      } else if (checkRole === "maintainer") {
        const origin = determineMembershipOrigin({
          mutationState: grant.membership_mutation_state,
          membershipCreatedByApp: grant.membership_created_by_app === 1,
          observedRole: "maintainer",
        });

        this.db.transaction(() => {
          if (origin === "preexisting") {
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              "already_present",
              0,
              "maintainer",
            );

            auditRepo.writeEventTx({
              eventType: "grant.recovered_after_uncertain_result",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                operation_id: grant.membership_add_operation_id,
                previous_mutation_state: "add_request_sent",
                observed_role: "maintainer",
                recovery_reason: "membership_present_as_maintainer_after_timeout",
              }),
            });
          } else {
            this.grantRepo.updateGrantStatusAndMembership(
              grantId,
              "active",
              1,
              null,
            );
            this.grantRepo.updateGrantStatus(
              grantId,
              "active",
              null,
              "membership_elevated",
              "User was elevated to Maintainer of the team on GitHub.",
            );
            this.grantRepo.updateMutationState(grantId, {
              membershipMutationState: "membership_confirmed",
              membershipAddLastVerifiedAt: new Date().toISOString(),
            });

            auditRepo.writeEventTx({
              eventType: "grant.membership_origin_preserved",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                grant_id: grantId,
                observed_role: "maintainer",
                membership_created_by_app: true,
                mutation_state: grant.membership_mutation_state,
                action: "preserved_app_created_origin",
              }),
            });

            auditRepo.writeEventTx({
              eventType: "grant.membership_elevated",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                observed_role: "maintainer",
                context: "timeout_recovery",
              }),
            });
          }
          this.jobRepo.completeJob(job.id);
        })();
        return;
      } else {
        throw err; // Rethrow to retry
      }
    }

    // 5. Verify Live Membership After Mutation
    let verifiedMembership: { role?: string } | null = null;
    try {
      verifiedMembership = await this.githubClient.getTeamMembership(
        grant.target_team_id,
        grant.github_user_id,
      );
    } catch (err) {
      if ((err as Error).name !== "GitHubNotFoundError") {
        throw err;
      }
    }

    if (
      verifiedMembership?.role === "member" ||
      verifiedMembership?.role === "maintainer"
    ) {
      logger.info({ grantId }, "GitHub team membership verified successfully");
      const confirmedRole = verifiedMembership.role;

      if (confirmedRole === "maintainer") {
        this.db.transaction(() => {
          this.grantRepo.updateMutationState(grantId, {
            membershipMutationState: "membership_confirmed",
            membershipAddLastVerifiedAt: new Date().toISOString(),
          });
          this.grantRepo.updateGrantStatusAndMembership(
            grantId,
            "active",
            1,
            null,
          );
          this.grantRepo.updateGrantStatus(
            grantId,
            "active",
            null,
            "membership_elevated",
            "User was elevated to Maintainer of the team on GitHub.",
          );
          this.jobRepo.completeJob(job.id);

          auditRepo.writeEventTx({
            eventType: "grant.succeeded",
            actorType: "system",
            githubOrgId: grant.github_org_id,
            githubUserId: grant.github_user_id,
            githubTeamId: grant.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              membership_created_by_app: true,
              github_role: "maintainer",
              confirmed_at: new Date().toISOString(),
              operation_id: grant.membership_add_operation_id,
            }),
          });
        })();
      } else {
        this.db.transaction(() => {
          this.grantRepo.updateMutationState(grantId, {
            membershipMutationState: "membership_confirmed",
            membershipAddLastVerifiedAt: new Date().toISOString(),
          });
          this.grantRepo.updateGrantStatusAndMembership(
            grantId,
            "active",
            1,
            null,
          );
          this.jobRepo.completeJob(job.id);

          auditRepo.writeEventTx({
            eventType: "grant.succeeded",
            actorType: "system",
            githubOrgId: grant.github_org_id,
            githubUserId: grant.github_user_id,
            githubTeamId: grant.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              membership_created_by_app: true,
              github_role: "member",
              confirmed_at: new Date().toISOString(),
              operation_id: grant.membership_add_operation_id,
            }),
          });
        })();
      }

      // Enqueue Slack notifications
      const requests = this.grantRepo.listGrantRequests(grantId);
      const requestRepo = new RequestRepository(this.db);
      const maxDuration =
        requests.length > 0
          ? Math.max(
              ...requests.map((r) => {
                const req = requestRepo.getRequest(r.access_request_id);
                return req ? req.duration_minutes : 60;
              }),
            )
          : 60;

      this.db.transaction(() => {
        // Enqueue result notification
        this.jobRepo.createJob({
          id: crypto.randomUUID(),
          type: "notify_request_result",
          payloadJson: JSON.stringify({
            requestId: grantId,
            slackUserId,
            teamName,
            status: "approved",
            durationMinutes: maxDuration,
          }),
          runAfter: new Date().toISOString(),
        });

        // Enqueue audit log notification
        this.jobRepo.createJob({
          id: crypto.randomUUID(),
          type: "post_audit_notification",
          payloadJson: JSON.stringify({
            eventId: crypto.randomUUID(),
            eventType: "grant.succeeded",
            grantId,
            requestId: requests[0]?.access_request_id || "unknown",
            slackUserId,
            githubLogin: grant.github_login_snapshot,
            teamName,
            wasPreexisting: false,
            status: "approved",
            durationMinutes: maxDuration,
          }),
          runAfter: new Date().toISOString(),
        });
      })();
    } else {
      throw new Error(
        "GitHub add team member succeeded but verified membership was not found",
      );
    }
  }

  private async markGrantPermanentlyFailed(
    jobId: string,
    grantId: string,
    errorCode: string,
    errorMessage: string,
    slackUserId: string | null,
    teamName: string,
  ): Promise<void> {
    logger.warn(
      { grantId, errorCode, errorMessage },
      "Marking grant permanently failed",
    );

    const grant = this.grantRepo.getGrant(grantId)!;
    const auditRepo = new (
      await import("../persistence/repositories/audit-repository.js")
    ).AuditRepository(this.db);

    this.db.transaction(() => {
      this.grantRepo.updateGrantStatus(
        grantId,
        "grant_failed",
        null,
        errorCode,
        errorMessage,
      );
      this.jobRepo.failJob(jobId, `${errorCode}: ${errorMessage}`);

      auditRepo.writeEventTx({
        eventType: "grant.failed",
        actorType: "system",
        githubOrgId: grant.github_org_id,
        githubUserId: grant.github_user_id,
        githubTeamId: grant.target_team_id,
        grantId,
        payloadJson: JSON.stringify({
          error_code: errorCode,
          error_message: errorMessage,
        }),
      });

      // Enqueue Slack notification job
      this.jobRepo.createJob({
        id: crypto.randomUUID(),
        type: "notify_request_result",
        payloadJson: JSON.stringify({
          requestId: grantId,
          slackUserId,
          teamName,
          status: "grant_failed",
          durationMinutes: 0,
        }),
        runAfter: new Date().toISOString(),
      });
    })();
  }

  private async handleJobFailure(job: DbJob, err: unknown): Promise<void> {
    const attempt = job.attempt_count;
    const maxAttempts = config.JOB_MAX_ATTEMPTS || 10;
    const isPermanentFailure = attempt >= maxAttempts;
    const typedErr = err as { message?: string; status?: number };

    const redactMessage = (msg: string): string => {
      if (!msg) return msg;
      return msg
        .replace(/xoxb-[a-zA-Z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
        .replace(/ghs_[a-zA-Z0-9]+/g, "[REDACTED_GITHUB_TOKEN]")
        .replace(/ghp_[a-zA-Z0-9]+/g, "[REDACTED_GITHUB_TOKEN]");
    };

    switch (job.type) {
      case "grant_access": {
        if (isPermanentFailure) {
          logger.fatal(
            { jobId: job.id, attempt },
            "grant_access job reached maximum attempts. Marking permanently failed.",
          );
          const { grantId } = JSON.parse(job.payload_json);
          if (grantId) {
            const grant = this.grantRepo.getGrant(grantId)!;
            const auditRepo = new (
              await import("../persistence/repositories/audit-repository.js")
            ).AuditRepository(this.db);

            this.db.transaction(() => {
              this.jobRepo.failJob(job.id, redactMessage(typedErr.message || "Max attempts reached"));
              this.grantRepo.updateGrantStatus(
                grantId,
                "grant_failed",
                null,
                "max_attempts_exceeded",
                redactMessage(typedErr.message || "Max attempts reached"),
              );
 
              auditRepo.writeEventTx({
                eventType: "grant.failed",
                actorType: "system",
                githubOrgId: grant.github_org_id,
                githubUserId: grant.github_user_id,
                githubTeamId: grant.target_team_id,
                grantId,
                payloadJson: JSON.stringify({
                  error_code: "max_attempts_exceeded",
                  error_message: redactMessage(typedErr.message || "Max attempts reached"),
                }),
              });
            })();
          } else {
            this.jobRepo.failJob(job.id, redactMessage(typedErr.message || "Max attempts reached"));
          }
        } else {
          await this.releaseJobForRetry(job, err);
        }
        break;
      }

      case "revoke_access": {
        const { grantId } = JSON.parse(job.payload_json);
        logger.warn(
          { jobId: job.id, grantId, attempt },
          "revoke_access job failed. Rescheduling for retry in 1 hour.",
        );

        if (grantId) {
          const grant = this.grantRepo.getGrant(grantId)!;
          const auditRepo = new (
            await import("../persistence/repositories/audit-repository.js")
          ).AuditRepository(this.db);

          const nextAttemptAt = new Date(Date.now() + 3600 * 1000).toISOString();

          this.db.transaction(() => {
            this.jobRepo.releaseJobForRetry(
              job.id,
              nextAttemptAt,
              redactMessage(typedErr.message || "Revocation failed, retrying in 1 hour"),
            );

            this.grantRepo.updateRevocationStatus(grantId, {
              status: "revoke_failed",
              revokedAt: null,
              attemptCount: grant.revoke_attempt_count + 1,
              nextAttemptAt: nextAttemptAt,
              errorCode: typedErr.status ? String(typedErr.status) : "ERROR",
              errorMessage: redactMessage(typedErr.message || "Unknown revocation error"),
            });

            auditRepo.writeEventTx({
              eventType: "revoke.retry_scheduled",
              actorType: "system",
              githubOrgId: grant.github_org_id,
              githubUserId: grant.github_user_id,
              githubTeamId: grant.target_team_id,
              grantId,
              payloadJson: JSON.stringify({
                attemptCount: grant.revoke_attempt_count + 1,
                nextAttemptAt,
              }),
            });
          })();
        } else {
          await this.releaseJobForRetry(job, err);
        }
        break;
      }

      case "notify_request_result":
      case "notify_revocation_result":
      case "post_audit_notification": {
        if (isPermanentFailure) {
          logger.error(
            { jobId: job.id, attempt },
            "Notification job reached maximum attempts. Marking permanently failed.",
          );
          const idempotencyKey = this.extractIdempotencyKey(job);
          if (idempotencyKey) {
            this.db.transaction(() => {
              this.db.prepare(
                `UPDATE notification_deliveries SET status = 'dead', updated_at = ? WHERE idempotency_key = ?`
              ).run(new Date().toISOString(), idempotencyKey);
              this.jobRepo.failJob(job.id, redactMessage(typedErr.message || "Max attempts reached"));
            })();
          } else {
            this.jobRepo.failJob(job.id, redactMessage(typedErr.message || "Max attempts reached"));
          }
        } else {
          await this.releaseJobForRetry(job, err);
        }
        break;
      }

      case "refresh_team_cache": {
        if (isPermanentFailure) {
          logger.error(
            { jobId: job.id },
            "refresh_team_cache reached maximum attempts. Marking failed. Existing cache is maintained.",
          );
          this.jobRepo.failJob(job.id, redactMessage(typedErr.message || "Max attempts reached"));
        } else {
          await this.releaseJobForRetry(job, err);
        }
        break;
      }

      case "validate_policy_authority": {
        if (isPermanentFailure) {
          logger.error(
            { jobId: job.id },
            "validate_policy_authority reached maximum attempts. Policy is NOT disabled, will re-verify next time.",
          );
          const auditRepo = new (
            await import("../persistence/repositories/audit-repository.js")
          ).AuditRepository(this.db);
          
          this.db.transaction(() => {
            this.jobRepo.failJob(job.id, redactMessage(typedErr.message || "Max attempts reached"));
            auditRepo.writeEventTx({
              eventType: "policy.validation_failed_permanently",
              actorType: "system",
              payloadJson: JSON.stringify({
                error: redactMessage(typedErr.message || "Max attempts reached"),
              }),
            });
          })();
        } else {
          await this.releaseJobForRetry(job, err);
        }
        break;
      }

      default: {
        if (isPermanentFailure) {
          logger.error({ jobId: job.id }, "Generic job failure permanently failed.");
          this.jobRepo.failJob(job.id, redactMessage(typedErr.message || "Max attempts reached"));
        } else {
          await this.releaseJobForRetry(job, err);
        }
      }
    }
  }

  private async releaseJobForRetry(job: DbJob, err: unknown): Promise<void> {
    const attempt = job.attempt_count;
    const delays = [10, 60, 300];
    const delaySeconds = delays[attempt - 1] || 900;
    const nextRunAfter = new Date(
      Date.now() + delaySeconds * 1000,
    ).toISOString();

    logger.info(
      { jobId: job.id, attempt, nextRunAfter },
      "Releasing job for retry",
    );
    
    const redactMessage = (msg: string): string => {
      if (!msg) return msg;
      return msg
        .replace(/xoxb-[a-zA-Z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
        .replace(/ghs_[a-zA-Z0-9]+/g, "[REDACTED_GITHUB_TOKEN]")
        .replace(/ghp_[a-zA-Z0-9]+/g, "[REDACTED_GITHUB_TOKEN]");
    };

    const typedErr = err as { message?: string };
    this.jobRepo.releaseJobForRetry(
      job.id,
      nextRunAfter,
      redactMessage(typedErr.message || "Transient error"),
    );
  }

  private extractIdempotencyKey(job: DbJob): string | null {
    try {
      const payload = JSON.parse(job.payload_json);
      if (job.type === "notify_request_result") {
        const { requestId, status } = payload;
        if (status === "approved" || status === "already_present") {
          return `request_granted:${requestId}`;
        } else if (status === "revoked") {
          return `grant_revoked:${requestId}`;
        } else {
          return `request_failed:${requestId}`;
        }
      } else if (job.type === "post_audit_notification") {
        const { eventId, requestId, grantId, status } = payload;
        if (status === "failed") {
          const alertWindow = Math.floor(Date.now() / (5 * 60 * 1000));
          return `revoke_failed_alert:${grantId || requestId || "unknown"}:${alertWindow}`;
        } else {
          return `audit_event:${eventId || requestId || "unknown"}`;
        }
      }
    } catch {
      // Ignore
    }
    return null;
  }

  private async handleNotifyRequestResult(job: DbJob): Promise<void> {
    const { requestId, slackUserId, teamName, status, durationMinutes } =
      JSON.parse(job.payload_json);

    const parsedPayload = JSON.parse(job.payload_json);
    let idempotencyKey = parsedPayload.idempotencyKey;
    if (!idempotencyKey) {
      if (status === "approved" || status === "already_present") {
        idempotencyKey = `request_granted:${requestId}`;
      } else if (status === "revoked") {
        idempotencyKey = `grant_revoked:${requestId}`;
      } else {
        idempotencyKey = `request_failed:${requestId}`;
      }
    }

    const now = new Date().toISOString();

    const delivery = this.db.transaction(() => {
      let row = this.db
        .prepare(
          "SELECT * FROM notification_deliveries WHERE idempotency_key = ?",
        )
        .get(idempotencyKey) as { id: string; status: string; attempt_count: number } | undefined;
      if (!row) {
        const id = crypto.randomUUID();
        this.db
          .prepare(
            `
          INSERT INTO notification_deliveries (
            id, idempotency_key, notification_type, entity_id, status, attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
        `,
          )
          .run(id, idempotencyKey, "request_result", requestId, now, now);
        row = this.db
          .prepare(
            "SELECT * FROM notification_deliveries WHERE idempotency_key = ?",
          )
          .get(idempotencyKey) as { id: string; status: string; attempt_count: number } | undefined;
      }
      return row;
    })() as { id: string; status: string; attempt_count: number };

    if (delivery.status === "sent") {
      logger.info(
        { idempotencyKey },
        "Notification already sent, completing job",
      );
      this.jobRepo.completeJob(job.id);
      return;
    }

    const acquired =
      this.db
        .prepare(
          `
      UPDATE notification_deliveries
      SET status = 'sending', updated_at = ?
      WHERE idempotency_key = ? AND status IN ('pending', 'failed')
    `,
        )
        .run(now, idempotencyKey).changes === 1;

    if (!acquired) {
      throw new Error(
        `Notification ${idempotencyKey} is currently sending or already sent.`,
      );
    }

    try {
      if (slackUserId) {
        if (status === "revoked") {
          await this.notifier.notifyRevocation({
            slackUserId,
            teamName,
            wasPreexisting: false,
          });
        } else {
          await this.notifier.notifyRequester({
            slackUserId,
            teamName,
            status,
            durationMinutes,
          });
        }
      }

      this.db
        .prepare(
          `
        UPDATE notification_deliveries
        SET status = 'sent', sent_at = ?, updated_at = ?
        WHERE idempotency_key = ?
      `,
        )
        .run(
          new Date().toISOString(),
          new Date().toISOString(),
          idempotencyKey,
        );

      this.jobRepo.completeJob(job.id);
    } catch (err) {
      const typedErr = err as { message?: string };
      let errorMessage = typedErr.message || "Unknown error";
      if (errorMessage.includes("xoxb-")) {
        errorMessage = "Slack API error: Auth token leaked (redacted)";
      }

      const nextAttempt = new Date(
        Date.now() +
          calculateNotificationRetryDelay(delivery.attempt_count + 1) * 1000,
      ).toISOString();

      this.db
        .prepare(
          `
        UPDATE notification_deliveries
        SET status = 'failed',
            attempt_count = attempt_count + 1,
            last_error = ?,
            next_attempt_at = ?,
            updated_at = ?
        WHERE idempotency_key = ?
      `,
        )
        .run(
          errorMessage,
          nextAttempt,
          new Date().toISOString(),
          idempotencyKey,
        );

      throw err;
    }
  }

  private async handlePostAuditNotification(job: DbJob): Promise<void> {
    const {
      eventId,
      grantId,
      requestId,
      slackUserId,
      githubLogin,
      teamName,
      wasPreexisting,
      status,
      errorMessage,
      idempotencyKey: payloadIdempotencyKey,
    } = JSON.parse(job.payload_json);

    let idempotencyKey = payloadIdempotencyKey;
    if (!idempotencyKey) {
      if (status === "failed") {
        const alertWindow = Math.floor(Date.now() / (5 * 60 * 1000));
        idempotencyKey = `revoke_failed_alert:${grantId || requestId}:${alertWindow}`;
      } else {
        idempotencyKey = `audit_event:${eventId || requestId || crypto.randomUUID()}`;
      }
    }

    const now = new Date().toISOString();

    const delivery = this.db.transaction(() => {
      let row = this.db
        .prepare(
          "SELECT * FROM notification_deliveries WHERE idempotency_key = ?",
        )
        .get(idempotencyKey) as { id: string; status: string; attempt_count: number } | undefined;
      if (!row) {
        const id = crypto.randomUUID();
        this.db
          .prepare(
            `
          INSERT INTO notification_deliveries (
            id, idempotency_key, notification_type, entity_id, status, attempt_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
        `,
          )
          .run(
            id,
            idempotencyKey,
            "audit_notification",
            grantId || requestId || "unknown",
            now,
            now,
          );
        row = this.db
          .prepare(
            "SELECT * FROM notification_deliveries WHERE idempotency_key = ?",
          )
          .get(idempotencyKey) as { id: string; status: string; attempt_count: number } | undefined;
      }
      return row;
    })() as { id: string; status: string; attempt_count: number };

    if (delivery.status === "sent") {
      logger.info(
        { idempotencyKey },
        "Audit notification already sent, completing job",
      );
      this.jobRepo.completeJob(job.id);
      return;
    }

    const acquired =
      this.db
        .prepare(
          `
      UPDATE notification_deliveries
      SET status = 'sending', updated_at = ?
      WHERE idempotency_key = ? AND status IN ('pending', 'failed')
    `,
        )
        .run(now, idempotencyKey).changes === 1;

    if (!acquired) {
      throw new Error(
        `Notification ${idempotencyKey} is currently sending or already sent.`,
      );
    }

    try {
      if (status === "failed") {
        await this.notifier.postAuditRevocation({
          grantId: grantId || "unknown",
          slackUserId: slackUserId || "unknown",
          githubLogin: githubLogin || "unknown",
          teamName: teamName || "unknown",
          wasPreexisting: wasPreexisting || false,
          status: "failed",
          errorMessage,
        });
      } else if (status === "revoked") {
        await this.notifier.postAuditRevocation({
          grantId: grantId || "unknown",
          slackUserId: slackUserId || "unknown",
          githubLogin: githubLogin || "unknown",
          teamName: teamName || "unknown",
          wasPreexisting: wasPreexisting || false,
          status: "revoked",
        });
      } else {
        await this.notifier.postAuditLog({
          requestId: requestId || grantId || "unknown",
          slackUserId: slackUserId || "unknown",
          githubLogin: githubLogin || "unknown",
          teamName: teamName || "unknown",
          durationMinutes: 0,
          decisionMode: "manual",
          approverSlackUserId: slackUserId,
          status,
        });
      }

      this.db
        .prepare(
          `
        UPDATE notification_deliveries
        SET status = 'sent', sent_at = ?, updated_at = ?
        WHERE idempotency_key = ?
      `,
        )
        .run(
          new Date().toISOString(),
          new Date().toISOString(),
          idempotencyKey,
        );

      this.jobRepo.completeJob(job.id);
    } catch (err) {
      const typedErr = err as { message?: string };
      let errorMessage = typedErr.message || "Unknown error";
      if (errorMessage.includes("xoxb-")) {
        errorMessage = "Slack API error: Auth token leaked (redacted)";
      }

      const nextAttempt = new Date(
        Date.now() +
          calculateNotificationRetryDelay(delivery.attempt_count + 1) * 1000,
      ).toISOString();

      this.db
        .prepare(
          `
        UPDATE notification_deliveries
        SET status = 'failed',
            attempt_count = attempt_count + 1,
            last_error = ?,
            next_attempt_at = ?,
            updated_at = ?
        WHERE idempotency_key = ?
      `,
        )
        .run(
          errorMessage,
          nextAttempt,
          new Date().toISOString(),
          idempotencyKey,
        );

      throw err;
    }
  }
}

export function calculateNotificationRetryDelay(attempt: number): number {
  if (attempt === 1) return 60; // 1m
  if (attempt === 2) return 5 * 60; // 5m
  if (attempt === 3) return 15 * 60; // 15m
  return 60 * 60; // 1h
}
