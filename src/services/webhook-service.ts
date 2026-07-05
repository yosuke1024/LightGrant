import Database from "better-sqlite3";
import crypto from "crypto";
import { logger } from "../logger.js";
import { AuditRepository } from "../persistence/repositories/audit-repository.js";
import { GrantRepository } from "../persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../persistence/repositories/identity-repository.js";
import { JobRepository } from "../persistence/repositories/job-repository.js";
import { TeamRepository } from "../persistence/repositories/team-repository.js";
import { GitHubOrganizationContext } from "../domain/github-organization-context.js";
import { GitHubAccessProvider } from "../integrations/github/github-client.js";

export class WebhookService {
  private auditRepo: AuditRepository;
  private grantRepo: GrantRepository;
  private identityRepo: IdentityRepository;
  private jobRepo: JobRepository;
  private teamRepo: TeamRepository;

  constructor(
    private db: Database.Database,
    private orgContext: GitHubOrganizationContext,
    private githubClient: GitHubAccessProvider,
  ) {
    this.auditRepo = new AuditRepository(db);
    this.grantRepo = new GrantRepository(db);
    this.identityRepo = new IdentityRepository(db);
    this.jobRepo = new JobRepository(db);
    this.teamRepo = new TeamRepository(db);
  }

  /**
   * Process a single webhook delivery with CAS-based concurrency protection.
   */
  async processDelivery(
    deliveryId: string,
    eventName: string,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const now = new Date().toISOString();

    // 1. CAS Lease to "processing"
    const leaseDurationMs = 30 * 1000; // 30s
    const leaseExpiresAt = new Date(Date.now() + leaseDurationMs).toISOString();

    const acquired = this.db.transaction(() => {
      const result = this.db.prepare(
        `
        UPDATE webhook_deliveries
        SET status = 'processing',
            processing_started_at = ?,
            lease_expires_at = ?,
            attempt_count = attempt_count + 1,
            last_error = NULL
        WHERE provider = 'github'
          AND delivery_id = ?
          AND (
            status IN ('received', 'failed')
            OR (
              status = 'processing'
              AND lease_expires_at <= ?
            )
          )
        `
      ).run(now, leaseExpiresAt, deliveryId, now);
      return result.changes === 1;
    })();

    if (!acquired) {
      logger.warn({ deliveryId }, "Failed to acquire lease for webhook delivery processing");
      return false;
    }

    try {
      // 2. Validate Organization ID
      const orgId = (payload.organization as { id?: number } | undefined)?.id;
      if (orgId && orgId !== this.orgContext.organizationId) {
        logger.warn(
          {
            deliveryId,
            payloadOrgId: orgId,
            configuredOrgId: this.orgContext.organizationId,
          },
          "Webhook processing aborted: Organization ID mismatch",
        );

        this.db.transaction(() => {
          this.auditRepo.writeEventTx({
            eventType: "webhook.organization_id_mismatch",
            actorType: "github_webhook",
            actorId: `webhook-${deliveryId}`,
            githubOrgId: this.orgContext.organizationId,
            payloadJson: JSON.stringify({
              received_org_id: orgId,
              expected_org_id: this.orgContext.organizationId,
              deliveryId,
            }),
          });
        })();

        this.db.prepare(
          `
          UPDATE webhook_deliveries
          SET status = 'failed', last_error = 'Organization ID mismatch'
          WHERE provider = 'github' AND delivery_id = ?
          `
        ).run(deliveryId);
        return false;
      }

      // 3. Handle Webhook Payload Event
      if (eventName === "membership") {
        await this.handleMembershipEvent(deliveryId, payload, now);
      }

      // 4. Update status to processed
      this.db.prepare(
        `
        UPDATE webhook_deliveries
        SET processed_at = ?, status = 'processed', lease_expires_at = NULL, last_error = NULL
        WHERE provider = 'github' AND delivery_id = ?
        `
      ).run(now, deliveryId);

      logger.info({ deliveryId }, "Webhook delivery processed successfully");
      return true;
    } catch (err) {
      logger.error({ err, deliveryId }, "Error processing Webhook delivery");

      const typedErr = err as { message?: string };
      this.db.prepare(
        `
        UPDATE webhook_deliveries
        SET status = 'failed', last_error = ?, lease_expires_at = NULL
        WHERE provider = 'github' AND delivery_id = ?
        `
      ).run(typedErr.message || "Unknown processing error", deliveryId);

      return false;
    }
  }

  private async handleMembershipEvent(
    deliveryId: string,
    payload: Record<string, unknown>,
    now: string,
  ): Promise<void> {
    const action = payload.action as string;
    const teamId = (payload.team as { id?: number } | undefined)?.id;
    const githubUserId = (payload.member as { id?: number } | undefined)?.id;
    const githubLogin = (payload.member as { login?: string } | undefined)?.login;

    if (!teamId || !githubUserId) {
      return;
    }

    // 1. Live role retrieval from GitHub API
    let liveRole: "member" | "maintainer" | "pending" | "absent" = "absent";
    try {
      const membership = await this.githubClient.getTeamMembership(teamId, githubUserId);
      if (membership) {
        liveRole = membership.role;
      }
    } catch (err) {
      const typedErr = err as { status?: number; name?: string; message?: string };
      if (typedErr.status === 401 || typedErr.status === 403 || typedErr.name === "GitHubUnauthorizedError") {
        logger.error({ err, teamId, githubUserId }, "GitHub API Permission Error during Webhook live sync (Operational Alert)");
        const { healthState } = await import("../http/health-routes.js");
        healthState.githubError = typedErr.message || "GitHub API Permission Error";
        throw err;
      } else {
        logger.warn({ err, teamId, githubUserId }, "GitHub API Transient Error during Webhook live sync");
        throw err;
      }
    }

    const activeGrant = this.grantRepo.findActiveGrant(
      this.orgContext.organizationId,
      teamId,
      githubUserId,
    );

    // 2. State reconciliation and audit dispatch based on event action & live role
    if (action === "removed") {
      if (liveRole === "absent") {
        if (activeGrant) {
          logger.warn(
            { grantId: activeGrant.id, teamId, githubUserId },
            "Active grant membership removed manually on GitHub. Updating grant status.",
          );

          this.db.transaction(() => {
            this.grantRepo.updateRevocationStatus(activeGrant.id, {
              status: "revoked",
              revokedAt: now,
              attemptCount: 0,
              nextAttemptAt: null,
              errorCode: "manually_removed_from_github",
              errorMessage: "User was removed from team directly on GitHub.",
            });

            this.auditRepo.writeEventTx({
              eventType: "grant.drift_detected",
              actorType: "github_webhook",
              actorId: `webhook-${deliveryId}`,
              githubOrgId: activeGrant.github_org_id,
              githubUserId,
              githubTeamId: teamId,
              grantId: activeGrant.id,
              payloadJson: JSON.stringify({
                drift_type: "manual_removal_on_github",
                expected_status: "active",
                actual_status: "revoked",
                deliveryId,
              }),
            });

            this.auditRepo.writeEventTx({
              eventType: "grant_revoked",
              actorType: "github_webhook",
              actorId: `webhook-${deliveryId}`,
              githubOrgId: activeGrant.github_org_id,
              githubUserId,
              githubTeamId: teamId,
              grantId: activeGrant.id,
              payloadJson: JSON.stringify({
                reason: "manually_removed_from_github",
                deliveryId,
              }),
            });

            const link = this.identityRepo.getLinkByGitHubUserGlobal(githubUserId);
            if (link) {
              const cachedTeam = this.teamRepo.getTeam(teamId);
              const teamName = cachedTeam ? cachedTeam.name : `GitHub Team ${teamId}`;

              this.jobRepo.createJob({
                id: crypto.randomUUID(),
                type: "notify_request_result",
                payloadJson: JSON.stringify({
                  requestId: activeGrant.id,
                  slackUserId: link.slack_user_id,
                  teamName,
                  status: "revoked",
                  durationMinutes: 0,
                }),
                runAfter: now,
              });

              this.jobRepo.createJob({
                id: crypto.randomUUID(),
                type: "post_audit_notification",
                payloadJson: JSON.stringify({
                  eventId: crypto.randomUUID(),
                  eventType: "grant_revoked",
                  grantId: activeGrant.id,
                  slackUserId: link.slack_user_id,
                  githubLogin: link.github_login,
                  teamName,
                  wasPreexisting: false,
                  status: "revoked",
                }),
                runAfter: now,
              });
            }
          })();
        }
      } else {
        // Event and current state mismatch
        logger.error(
          { deliveryId, action, liveRole, teamId, githubUserId },
          "Mismatch: Webhook action 'removed' received but user is still present on GitHub.",
        );
        this.db.transaction(() => {
          this.auditRepo.writeEventTx({
            eventType: "github.membership_mismatch_detected",
            actorType: "github_webhook",
            actorId: `webhook-${deliveryId}`,
            githubOrgId: this.orgContext.organizationId,
            githubUserId,
            githubTeamId: teamId,
            payloadJson: JSON.stringify({
              action,
              live_role: liveRole,
              deliveryId,
            }),
          });
        })();
      }
    } else {
      // action is added or edited
      if (liveRole === "member" || liveRole === "maintainer") {
        if (!activeGrant) {
          logger.warn(
            { teamId, githubUserId, githubLogin },
            "Membership added manually on GitHub (drift detected). Recording audit event.",
          );

          this.db.transaction(() => {
            this.auditRepo.writeEventTx({
              eventType: "github.external_membership_added",
              actorType: "github_webhook",
              actorId: `webhook-${deliveryId}`,
              githubOrgId: this.orgContext.organizationId,
              githubUserId,
              githubTeamId: teamId,
              payloadJson: JSON.stringify({
                action,
                observed_role: liveRole,
                deliveryId,
              }),
            });
          })();
        } else {
          // Active grant exists. Check for role updates
          const currentRole = activeGrant.preexisting_role || "member";
          if (liveRole === "maintainer" && currentRole !== "maintainer") {
            logger.warn(
              { grantId: activeGrant.id, teamId, githubUserId },
              "User elevated manually on GitHub to Maintainer. Updating role.",
            );
            this.db.transaction(() => {
              this.grantRepo.updateGrantStatusAndMembership(
                activeGrant.id,
                "active",
                1,
                null,
              );
              this.grantRepo.updateGrantStatus(
                activeGrant.id,
                 "active",
                 null,
                 "membership_elevated",
                 "User was elevated to Maintainer of the team on GitHub.",
              );

              this.auditRepo.writeEventTx({
                eventType: "grant.drift_detected",
                actorType: "github_webhook",
                actorId: `webhook-${deliveryId}`,
                githubOrgId: activeGrant.github_org_id,
                githubUserId,
                githubTeamId: teamId,
                grantId: activeGrant.id,
                payloadJson: JSON.stringify({
                  drift_type: "membership_elevated",
                  expected_role: "member",
                  actual_role: "maintainer",
                  deliveryId,
                }),
              });
            })();
          } else if (liveRole === "member" && activeGrant.last_error_code === "membership_elevated") {
            logger.warn(
              { grantId: activeGrant.id, teamId, githubUserId },
              "User demoted manually on GitHub to Member. Restoring role.",
            );
            this.db.transaction(() => {
              this.grantRepo.updateGrantStatusAndMembership(
                activeGrant.id,
                "active",
                1,
                null,
              );
              this.db.prepare(
                `
                UPDATE grants
                SET last_error_code = NULL,
                    last_error_message = ?,
                    updated_at = ?
                WHERE id = ?
                `
              ).run("User was demoted to Member of the team on GitHub.", now, activeGrant.id);

              this.auditRepo.writeEventTx({
                eventType: "grant.drift_detected",
                actorType: "github_webhook",
                actorId: `webhook-${deliveryId}`,
                githubOrgId: activeGrant.github_org_id,
                githubUserId,
                githubTeamId: teamId,
                grantId: activeGrant.id,
                payloadJson: JSON.stringify({
                  drift_type: "membership_demoted",
                  expected_role: "maintainer",
                  actual_role: "member",
                  deliveryId,
                }),
              });
            })();
          }
        }
      } else if (liveRole === "pending") {
        logger.error(
          { deliveryId, action, teamId, githubUserId },
          "User membership is pending on GitHub. Requires manual intervention.",
        );
        this.db.transaction(() => {
          this.auditRepo.writeEventTx({
            eventType: "github.membership_pending_alert",
            actorType: "github_webhook",
            actorId: `webhook-${deliveryId}`,
            githubOrgId: this.orgContext.organizationId,
            githubUserId,
            githubTeamId: teamId,
            payloadJson: JSON.stringify({
              action,
              deliveryId,
              status: "pending",
            }),
          });
        })();
      } else if (liveRole === "absent") {
        logger.error(
          { deliveryId, action, teamId, githubUserId },
          "Mismatch: Webhook action was added/edited but user is absent on GitHub.",
        );
        this.db.transaction(() => {
          this.auditRepo.writeEventTx({
            eventType: "github.membership_mismatch_detected",
            actorType: "github_webhook",
            actorId: `webhook-${deliveryId}`,
            githubOrgId: this.orgContext.organizationId,
            githubUserId,
            githubTeamId: teamId,
            payloadJson: JSON.stringify({
              action,
              live_role: "absent",
              deliveryId,
            }),
          });
        })();
      }
    }
  }

  /**
   * Reprocess a specific webhook delivery.
   */
  async reprocessDelivery(deliveryId: string): Promise<boolean> {
    const row = this.db.prepare(
      "SELECT * FROM webhook_deliveries WHERE provider = 'github' AND delivery_id = ?"
    ).get(deliveryId) as { payload_json: string; event_name: string } | undefined;

    if (!row) {
      logger.warn({ deliveryId }, "Webhook delivery not found for reprocessing");
      return false;
    }

    if (!row.payload_json) {
      logger.error({ deliveryId }, "Cannot reprocess: missing payload_json in webhook delivery");
      return false;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch (parseErr) {
      logger.error({ parseErr, deliveryId }, "Failed to parse payload_json during reprocessing");
      return false;
    }

    return this.processDelivery(deliveryId, row.event_name, payload);
  }

  /**
   * Reprocess all failed webhook deliveries.
   */
  async reprocessAllFailedDeliveries(): Promise<number> {
    const failedDeliveries = this.db.prepare(
      `
      SELECT * FROM webhook_deliveries
      WHERE provider = 'github'
        AND status = 'failed'
      `
    ).all() as Array<{ delivery_id: string }>;

    logger.info({ count: failedDeliveries.length }, "Starting reprocessing of failed webhook deliveries");

    let successCount = 0;
    for (const delivery of failedDeliveries) {
      try {
        const result = await this.reprocessDelivery(delivery.delivery_id);
        if (result) {
          successCount++;
        }
      } catch (err) {
        logger.error({ err, deliveryId: delivery.delivery_id }, "Failed to reprocess webhook delivery");
      }
    }
    return successCount;
  }
}
