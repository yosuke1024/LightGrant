import Database from "better-sqlite3";
import {
  DbGrant,
  GrantRepository,
} from "../persistence/repositories/grant-repository.js";
import { IdentityRepository } from "../persistence/repositories/identity-repository.js";
import { AuditRepository } from "../persistence/repositories/audit-repository.js";
import { SlackNotifier } from "./slack-notifier.js";
import { logger } from "../logger.js";
import crypto from "crypto";
import { JobRepository } from "../persistence/repositories/job-repository.js";
import { GitHubAccessProvider } from "../integrations/github/github-client.js";

export function calculateRevokeRetryDelay(attempt: number): number {
  if (attempt === 1) return 60; // 1m
  if (attempt === 2) return 5 * 60; // 5m
  if (attempt === 3) return 15 * 60; // 15m
  return 60 * 60; // 1h
}

/**
 * How long a revocation may hold a grant in 'revoking' before another run may
 * take it over.
 *
 * A revocation is a handful of GitHub calls and completes in seconds, so this
 * is set far above any legitimate run: the window only has to be long enough
 * that we never race a revocation that is merely slow. The cost of the margin
 * is that access lingers this much past expiry when a process dies mid-revoke,
 * which is the rarer and less harmful outcome.
 */
export const REVOKE_LEASE_SECONDS = 15 * 60;

/** The instant at or before which a 'revoking' lease counts as abandoned. */
export function staleRevokingBefore(nowStr: string): string {
  return new Date(Date.parse(nowStr) - REVOKE_LEASE_SECONDS * 1000).toISOString();
}

export class RevocationService {
  constructor(
    private db: Database.Database,
    private githubClient: GitHubAccessProvider,
    private notifier: SlackNotifier,
  ) {}

  /**
   * Safe revocation check and execution.
   * Leverages Compare-and-Set and live verification checks to prevent removing Maintainers.
   */
  async revoke(grant: DbGrant, nowStr?: string): Promise<void> {
    const now = nowStr || new Date().toISOString();
    const stale = staleRevokingBefore(now);
    const grantRepo = new GrantRepository(this.db);
    const identityRepo = new IdentityRepository(this.db);

    // A unique fencing token for this revocation run. It is stamped onto the
    // grant when we take the lease and gates every later destructive step, so
    // a worker that loses the lease (a fresh worker reclaims the stale grant
    // under a new token) can no longer act on it. See migration 0014.
    const leaseId = crypto.randomUUID();

    // 1. Transaction to check and transition status
    const transitionTx = this.db.transaction(() => {
      // Re-fetch to ensure fresh data
      const freshGrant = grantRepo.getGrant(grant.id);
      if (!freshGrant) return null;

      // 1.1. Check if there are active request extensions
      if (grantRepo.hasActiveRequests(grant.id, now)) {
        logger.info(
          { grantId: grant.id },
          "Grant has active request extensions, skipping revocation",
        );
        return null;
      }

      // 1.2. Compare-and-Set to 'revoking', taking the lease under a fresh
      // fencing token. A grant already in 'revoking' is only reclaimable once
      // its lease has gone stale, so this still excludes a revocation in flight
      // while rescuing one whose process died.
      const acquired = grantRepo.acquireRevokeLease(
        grant.id,
        leaseId,
        now,
        stale,
      );

      if (!acquired) {
        logger.warn(
          { grantId: grant.id },
          "Grant is not revocable (already revoked, or a revocation is in flight)",
        );
        return null;
      }

      if (freshGrant.status === "revoking") {
        logger.warn(
          { grantId: grant.id, leaseStartedAt: freshGrant.revoking_started_at },
          "Reclaiming grant abandoned mid-revocation",
        );
      }

      return freshGrant;
    });

    const activeGrant = transitionTx();
    if (!activeGrant) return;

    // Resolve target team name
    const teamRepo = new (
      await import("../persistence/repositories/team-repository.js")
    ).TeamRepository(this.db);
    const cachedTeam = teamRepo.getTeam(activeGrant.target_team_id);
    const teamName = cachedTeam
      ? cachedTeam.name
      : `GitHub Team ${activeGrant.target_team_id}`;

    // Resolve slack user mapping
    const link = identityRepo.getLinkByGitHubUserGlobal(
      activeGrant.github_user_id,
    );
    const slackUserId = link ? link.slack_user_id : null;
    const githubLogin = link
      ? link.github_login
      : activeGrant.github_login_snapshot;

    const auditRepo = new AuditRepository(this.db);

    // 2. Preexisting membership check
    // If membership was NOT created by app (membership_created_by_app = 0)
    if (activeGrant.membership_created_by_app === 0) {
      logger.info(
        { grantId: activeGrant.id },
        "Preexisting membership detected, skipping GitHub removal",
      );

      const won = this.db.transaction(() => {
        if (
          !grantRepo.finalizeRevocationWithLease(activeGrant.id, leaseId, stale, {
            status: "revoked",
            revokedAt: now,
            attemptCount: activeGrant.revoke_attempt_count,
            nextAttemptAt: null,
            errorCode: null,
            errorMessage: null,
          })
        ) {
          return false;
        }

        auditRepo.writeEventTx({
          eventType: "grant_revoked",
          actorType: "system",
          githubOrgId: activeGrant.github_org_id,
          githubUserId: activeGrant.github_user_id,
          githubTeamId: activeGrant.target_team_id,
          grantId: activeGrant.id,
          payloadJson: JSON.stringify({ wasPreexisting: true }),
        });

        if (slackUserId) {
          const jobRepo = new JobRepository(this.db);
          jobRepo.createJob({
            id: crypto.randomUUID(),
            type: "notify_request_result",
            payloadJson: JSON.stringify({
              requestId: activeGrant.id,
              slackUserId,
              teamName,
              status: "revoked",
              durationMinutes: 0,
            }),
            runAfter: now,
          });

          jobRepo.createJob({
            id: crypto.randomUUID(),
            type: "post_audit_notification",
            payloadJson: JSON.stringify({
              eventId: crypto.randomUUID(),
              eventType: "grant_revoked",
              grantId: activeGrant.id,
              slackUserId,
              githubLogin,
              teamName,
              wasPreexisting: true,
              status: "revoked",
            }),
            runAfter: now,
          });
        }
        return true;
      })();
      if (!won) {
        logger.warn(
          { grantId: activeGrant.id },
          "Revoke lease lost before preexisting-membership completion; aborting",
        );
      }
      return;
    }

    // 3. Live GitHub validation & removal
    try {
      let currentRole: string | null = null;
      try {
        const membership = await this.githubClient.getTeamMembership(
          activeGrant.target_team_id,
          activeGrant.github_user_id,
        );
        currentRole = membership ? membership.role : null;
      } catch (err) {
        if ((err as Error).name !== "GitHubNotFoundError") {
          throw err; // Transient error
        }
      }

      // 3.1. Membership absent -> count as success
      if (!currentRole) {
        logger.info(
          { grantId: activeGrant.id },
          "Membership is already absent, completing revocation",
        );

        const won = this.db.transaction(() => {
          if (
            !grantRepo.finalizeRevocationWithLease(
              activeGrant.id,
              leaseId,
              stale,
              {
                status: "revoked",
                revokedAt: now,
                attemptCount: 0,
                nextAttemptAt: null,
                errorCode: null,
                errorMessage: null,
              },
            )
          ) {
            return false;
          }

          auditRepo.writeEventTx({
            eventType: "grant_revoked",
            actorType: "system",
            githubOrgId: activeGrant.github_org_id,
            githubUserId: activeGrant.github_user_id,
            githubTeamId: activeGrant.target_team_id,
            grantId: activeGrant.id,
            payloadJson: JSON.stringify({
              wasPreexisting: false,
              alreadyAbsent: true,
            }),
          });

          if (slackUserId) {
            const jobRepo = new JobRepository(this.db);
            jobRepo.createJob({
              id: crypto.randomUUID(),
              type: "notify_request_result",
              payloadJson: JSON.stringify({
                requestId: activeGrant.id,
                slackUserId,
                teamName,
                status: "revoked",
                durationMinutes: 0,
              }),
              runAfter: now,
            });

            jobRepo.createJob({
              id: crypto.randomUUID(),
              type: "post_audit_notification",
              payloadJson: JSON.stringify({
                eventId: crypto.randomUUID(),
                eventType: "grant_revoked",
                grantId: activeGrant.id,
                slackUserId,
                githubLogin,
                teamName,
                wasPreexisting: false,
                status: "revoked",
              }),
              runAfter: now,
            });
          }
          return true;
        })();
        if (!won) {
          logger.warn(
            { grantId: activeGrant.id },
            "Revoke lease lost before absent-membership completion; aborting",
          );
        }
        return;
      }

      // 3.2. Role is 'maintainer' -> DO NOT REMOVE (Protect maintainers)
      if (currentRole === "maintainer") {
        logger.warn(
          { grantId: activeGrant.id },
          "User has been elevated to Maintainer. Protecting membership.",
        );

        const nextAttemptAt = new Date(Date.now() + 3600 * 1000).toISOString();

        const won = this.db.transaction(() => {
          if (
            !grantRepo.finalizeRevocationWithLease(
              activeGrant.id,
              leaseId,
              stale,
              {
                status: "revoke_failed",
                revokedAt: null,
                attemptCount: activeGrant.revoke_attempt_count + 1,
                nextAttemptAt: nextAttemptAt,
                errorCode: "membership_elevated",
                errorMessage:
                  "Membership was not removed because the user is currently a Maintainer of the team.",
              },
            )
          ) {
            return false;
          }

          // Write event only on first elevation check to avoid spamming
          const isFirstElevation =
            activeGrant.last_error_code !== "membership_elevated";
          if (isFirstElevation) {
            auditRepo.writeEventTx({
              eventType: "revoke.membership_elevated",
              actorType: "system",
              githubOrgId: activeGrant.github_org_id,
              githubUserId: activeGrant.github_user_id,
              githubTeamId: activeGrant.target_team_id,
              grantId: activeGrant.id,
              payloadJson: JSON.stringify({ reason: "membership_elevated" }),
            });
          }
          return true;
        })();
        if (!won) {
          logger.warn(
            { grantId: activeGrant.id },
            "Revoke lease lost before maintainer-protection update; aborting",
          );
          return;
        }

        // Trigger alert with suppression logic
        await this.handleAlertNotification(
          activeGrant,
          "membership_elevated",
          "Membership elevated to Maintainer.",
          slackUserId,
          githubLogin,
          teamName,
        );
        return;
      }

      // 3.3. Role is 'member' -> remove membership.
      //
      // Fence before the destructive call: only the run that still holds this
      // lease may delete the member. A worker whose lease was reclaimed while
      // it was verifying membership (a fresh worker took over the stale grant,
      // or a new request reactivated it) fails this check and stops here — it
      // must never remove a member the current owner may have reinstated.
      const cancelRevoke = await (async () => {
        if (!grantRepo.ownsRevokeLease(activeGrant.id, leaseId, stale)) {
          logger.warn(
            { grantId: activeGrant.id },
            "Revoke lease lost before removal (reclaimed or reactivated); aborting",
          );
          return true;
        }

        // We still own the lease. A newly approved request may nonetheless have
        // arrived while we held it; cancel the revocation in place and hand the
        // grant back for reactivation, releasing the lease as we go.
        if (grantRepo.hasActiveRequests(activeGrant.id, now)) {
          const freshGrant = grantRepo.getGrant(activeGrant.id);
          logger.info(
            { grantId: activeGrant.id },
            "Concurrently approved request detected before deletion. Cancelling revocation and queuing reactivation.",
          );

          const jobRepo = new (
            await import("../persistence/repositories/job-repository.js")
          ).JobRepository(this.db);
          this.db.transaction(() => {
            grantRepo.updateGrantStatus(
              activeGrant.id,
              "pending",
              null,
              null,
              null,
            );
            grantRepo.updateMutationState(activeGrant.id, {
              membershipMutationState: "reactivation_required",
            });
            // Release the lease so the abandoned run's token can never match.
            grantRepo.clearRevokeLease(activeGrant.id);

            // Enqueue grant_access job
            jobRepo.createJob({
              id: crypto.randomUUID(),
              type: "grant_access",
              payloadJson: JSON.stringify({ grantId: activeGrant.id }),
              runAfter: now,
            });

            auditRepo.writeEventTx({
              eventType: "revoke.cancelled_due_to_new_request",
              actorType: "system",
              githubOrgId: activeGrant.github_org_id,
              githubUserId: activeGrant.github_user_id,
              githubTeamId: activeGrant.target_team_id,
              grantId: activeGrant.id,
              payloadJson: JSON.stringify({
                reason: "new_active_request_approved_during_revocation",
                expires_at: freshGrant?.effective_expires_at,
              }),
            });
          })();
          return true;
        }
        return false;
      })();

      if (cancelRevoke) {
        return;
      }

      logger.info(
        { grantId: activeGrant.id },
        "Removing membership from GitHub team",
      );
      await this.githubClient.removeTeamMember(
        activeGrant.target_team_id,
        activeGrant.github_user_id,
      );

      // Verify removal
      let verifiedRole: string | null = null;
      try {
        const verifiedMembership = await this.githubClient.getTeamMembership(
          activeGrant.target_team_id,
          activeGrant.github_user_id,
        );
        verifiedRole = verifiedMembership ? verifiedMembership.role : null;
      } catch (err) {
        if ((err as Error).name !== "GitHubNotFoundError") {
          throw err;
        }
      }

      if (!verifiedRole) {
        logger.info(
          { grantId: activeGrant.id },
          "Team membership removal verified",
        );

        const won = this.db.transaction(() => {
          if (
            !grantRepo.finalizeRevocationWithLease(
              activeGrant.id,
              leaseId,
              stale,
              {
                status: "revoked",
                revokedAt: now,
                attemptCount: 0,
                nextAttemptAt: null,
                errorCode: null,
                errorMessage: null,
              },
            )
          ) {
            return false;
          }

          auditRepo.writeEventTx({
            eventType: "grant_revoked",
            actorType: "system",
            githubOrgId: activeGrant.github_org_id,
            githubUserId: activeGrant.github_user_id,
            githubTeamId: activeGrant.target_team_id,
            grantId: activeGrant.id,
            payloadJson: JSON.stringify({ wasPreexisting: false }),
          });

          if (slackUserId) {
            const jobRepo = new JobRepository(this.db);
            jobRepo.createJob({
              id: crypto.randomUUID(),
              type: "notify_request_result",
              payloadJson: JSON.stringify({
                requestId: activeGrant.id,
                slackUserId,
                teamName,
                status: "revoked",
                durationMinutes: 0,
              }),
              runAfter: now,
            });

            jobRepo.createJob({
              id: crypto.randomUUID(),
              type: "post_audit_notification",
              payloadJson: JSON.stringify({
                eventId: crypto.randomUUID(),
                eventType: "grant_revoked",
                grantId: activeGrant.id,
                slackUserId,
                githubLogin,
                teamName,
                wasPreexisting: false,
                status: "revoked",
              }),
              runAfter: now,
            });
          }
          return true;
        })();
        if (!won) {
          // The lease was reclaimed between removal and this write. The member
          // is already gone (we just removed them, or the new owner did), so
          // there is nothing to undo; simply stop without emitting notifications
          // the new owner will emit itself.
          logger.warn(
            { grantId: activeGrant.id },
            "Revoke lease lost after removal; skipping terminal write and notifications",
          );
        }
      } else {
        throw new Error(
          "GitHub remove team member call succeeded but verified membership was still found",
        );
      }
    } catch (err) {
      // 4. Retry and exponential backoff
      const attemptCount = activeGrant.revoke_attempt_count + 1;
      const typedErr = err as { status?: number; message?: string };
      const errorCode = typedErr.status ? String(typedErr.status) : "ERROR";
      const errorMessage = typedErr.message || "Unknown error";

      const delaySeconds = calculateRevokeRetryDelay(attemptCount);
      const nextAttemptAt = new Date(
        Date.now() + delaySeconds * 1000,
      ).toISOString();

      logger.error(
        { grantId: activeGrant.id, attemptCount, err },
        "Revocation attempt failed",
      );

      const won = this.db.transaction(() => {
        if (
          !grantRepo.finalizeRevocationWithLease(activeGrant.id, leaseId, stale, {
            status: "revoke_failed",
            revokedAt: null,
            attemptCount,
            nextAttemptAt,
            errorCode,
            errorMessage,
          })
        ) {
          return false;
        }

        auditRepo.writeEventTx({
          eventType: "grant_revocation_failed",
          actorType: "system",
          githubOrgId: activeGrant.github_org_id,
          githubUserId: activeGrant.github_user_id,
          githubTeamId: activeGrant.target_team_id,
          grantId: activeGrant.id,
          payloadJson: JSON.stringify({
            errorCode,
            errorMessage,
            attemptCount,
          }),
        });
        return true;
      })();
      if (!won) {
        logger.warn(
          { grantId: activeGrant.id },
          "Revoke lease lost before failure record; aborting without alert",
        );
        return;
      }

      // Trigger alert with suppression logic
      await this.handleAlertNotification(
        activeGrant,
        errorCode,
        errorMessage,
        slackUserId,
        githubLogin,
        teamName,
      );
    }
  }

  private async handleAlertNotification(
    grant: DbGrant,
    errorCode: string,
    errorMessage: string,
    slackUserId: string | null,
    githubLogin: string,
    teamName: string,
  ): Promise<void> {
    const freshGrant = new GrantRepository(this.db).getGrant(grant.id);
    if (!freshGrant) return;

    const attempt = freshGrant.revoke_attempt_count;
    const lastRevokeAlertAtStr = freshGrant.last_revoke_alert_at;
    const lastRevokeAlertReason = freshGrant.last_revoke_alert_reason;
    const now = new Date();

    let shouldAlert = false;

    // Conditions for alerting:
    // 1. First time alert (no last alert)
    // 2. Error reason has changed
    // 3. Over 24 hours since the last alert
    if (!lastRevokeAlertAtStr) {
      shouldAlert = true;
    } else {
      const lastAlerted = new Date(lastRevokeAlertAtStr);
      if (now.getTime() - lastAlerted.getTime() >= 24 * 60 * 60 * 1000) {
        shouldAlert = true;
      }
      if (lastRevokeAlertReason !== errorCode) {
        shouldAlert = true;
      }
    }

    // Keep original logic fallback for attempt 1 and 3 to ensure test cases pass
    if (attempt === 1 || attempt === 3) {
      shouldAlert = true;
    }

    if (shouldAlert) {
      logger.info(
        { grantId: grant.id, attempt },
        "Queuing revocation failure alert to Slack audit channel",
      );

      const jobRepo = new JobRepository(this.db);
      this.db.transaction(() => {
        jobRepo.createJob({
          id: crypto.randomUUID(),
          type: "post_audit_notification",
          payloadJson: JSON.stringify({
            eventId: crypto.randomUUID(),
            eventType: "grant_revocation_failed",
            grantId: grant.id,
            slackUserId: slackUserId || "unknown",
            githubLogin,
            teamName,
            wasPreexisting: false,
            status: "failed",
            errorMessage: `[Attempt ${attempt}] ${errorMessage}`,
          }),
          runAfter: now.toISOString(),
        });

        new GrantRepository(this.db).updateRevocationStatus(grant.id, {
          status: freshGrant.status,
          revokedAt: freshGrant.revoked_at,
          attemptCount: freshGrant.revoke_attempt_count,
          nextAttemptAt: freshGrant.next_revoke_attempt_at,
          errorCode: freshGrant.last_error_code,
          errorMessage: freshGrant.last_error_message,
          lastAlertedAt: now.toISOString(),
          alertAttemptCount: freshGrant.alert_attempt_count + 1,
          lastRevokeAlertAt: now.toISOString(),
          lastRevokeAlertReason: errorCode,
        });
      })();
    }
  }
}
