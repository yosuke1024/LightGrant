import Database from "better-sqlite3";
import { GrantRepository } from "../persistence/repositories/grant-repository.js";
import { AuditRepository } from "../persistence/repositories/audit-repository.js";
import { TeamRepository } from "../persistence/repositories/team-repository.js";
import { RevocationService } from "./revocation-service.js";
import { GitHubAccessProvider } from "../integrations/github/github-client.js";
import { logger } from "../logger.js";
import { GitHubOrganizationContext } from "../domain/github-organization-context.js";
import fs from "fs";

export class ReconciliationService {
  private grantRepo: GrantRepository;
  private lastPolicyValidationAt = 0;
  private lastTeamCacheRefreshAt = 0;

  constructor(
    private db: Database.Database,
    private githubClient: GitHubAccessProvider,
    private revocationService: RevocationService,
    private orgContext: GitHubOrganizationContext,
  ) {
    this.grantRepo = new GrantRepository(db);
  }

  /**
   * Scan for all expired grants and reconcile them (trigger revocation)
   */
  async reconcile(nowStr?: string): Promise<void> {
    const now = nowStr || new Date().toISOString();
    logger.debug({ now }, "Starting Reconciliation run");

    // 0. Clean up expired/used export tokens and release leases
    this.cleanupExportTokens(now);

    // 1. Process Expired Grants
    try {
      const expiredGrants = this.grantRepo.getExpiredGrants(now);
      if (expiredGrants.length > 0) {
        logger.info(
          { count: expiredGrants.length },
          "Found expired grants. Running reconciliation...",
        );

        for (const grant of expiredGrants) {
          try {
            await this.revocationService.revoke(grant, now);
          } catch (err) {
            logger.error(
              { grantId: grant.id, err },
              "Failed to reconcile specific grant",
            );
          }
        }
      } else {
        logger.debug("No expired grants to reconcile");
      }
    } catch (err) {
      logger.error({ err }, "Error scanning expired grants in reconciliation");
    }

    // 2. Enqueue periodic policy validation job
    try {
      const configModule = await import("../config.js");
      const refreshIntervalSeconds =
        configModule.config.POLICY_AUTHORITY_REFRESH_SECONDS || 3600;
      const nowMs = Date.now();

      if (
        nowMs - this.lastPolicyValidationAt >=
        refreshIntervalSeconds * 1000
      ) {
        this.lastPolicyValidationAt = nowMs;
        const jobRepo = new (
          await import("../persistence/repositories/job-repository.js")
        ).JobRepository(this.db);

        jobRepo.enqueuePolicyValidationJob();
        logger.info("Enqueued periodic policy authority validation job");
      }
    } catch (err) {
      logger.error(
        { err },
        "Error enqueuing policy validation job in reconciliation",
      );
    }

    // 3. Sync GitHub Teams Cache
    try {
      const configModule = await import("../config.js");
      const teamCacheIntervalSeconds =
        configModule.config.TEAM_CACHE_REFRESH_SECONDS || 600;
      const nowMs = Date.now();

      if (
        nowMs - this.lastTeamCacheRefreshAt >=
        teamCacheIntervalSeconds * 1000
      ) {
        this.lastTeamCacheRefreshAt = nowMs;

        logger.info("Starting GitHub teams cache synchronization...");
        const teams = await this.githubClient.listTeams();

        const teamRepo = new TeamRepository(this.db);
        const auditRepo = new AuditRepository(this.db);
        const timestamp = new Date().toISOString();

        this.db.transaction(() => {
          // Upsert retrieved teams
          teamRepo.upsertTeams(
            this.orgContext.organizationId,
            teams,
            timestamp,
          );

          // Mark others inactive
          const activeIds = teams.map((t) => t.id);
          teamRepo.markAllInactiveExcept(
            this.orgContext.organizationId,
            activeIds,
            timestamp,
          );

          // Write Audit Event
          auditRepo.writeEventTx({
            eventType: "team_cache_synchronized",
            actorType: "system",
            payloadJson: JSON.stringify({
              teamCount: teams.length,
              activeTeamIds: activeIds,
            }),
          });
        })();
        logger.info(
          { teamCount: teams.length },
          "GitHub teams cache synchronization successfully completed",
        );
      }
    } catch (err) {
      logger.error(
        { err },
        "Error synchronizing GitHub teams cache in reconciliation",
      );
    }
  }

  /**
   * Clean up expired or used export tokens, release expired leases, and delete orphan files.
   */
  private cleanupExportTokens(nowStr: string): void {
    try {
      // 1. Release expired leases (where used_at IS NULL AND download_lease_expires_at <= now)
      const expiredLeases = this.db.prepare(
        `
        SELECT * FROM export_tokens
        WHERE used_at IS NULL
          AND download_lease_expires_at IS NOT NULL
          AND download_lease_expires_at <= ?
        `
      ).all(nowStr) as Array<{ token_hash: string }>;

      if (expiredLeases.length > 0) {
        logger.info({ count: expiredLeases.length }, "Releasing expired download leases");
        for (const token of expiredLeases) {
          this.db.prepare(
            `UPDATE export_tokens SET download_started_at = NULL, download_lease_expires_at = NULL WHERE token_hash = ?`
          ).run(token.token_hash);
        }
      }

      // 2. Delete expired or used tokens, and clean up their files
      const toDelete = this.db.prepare(
        `
        SELECT * FROM export_tokens
        WHERE expires_at <= ?
           OR used_at IS NOT NULL
        `
      ).all(nowStr) as Array<{ token_hash: string; file_path: string }>;

      if (toDelete.length > 0) {
        logger.info({ count: toDelete.length }, "Cleaning up expired or used export tokens and files");
        for (const token of toDelete) {
          // Delete file if exists
          if (token.file_path && fs.existsSync(token.file_path)) {
            try {
              fs.unlinkSync(token.file_path);
              logger.debug({ filePath: token.file_path }, "Deleted export file during cleanup");
            } catch (unlinkErr) {
              logger.warn({ unlinkErr, filePath: token.file_path }, "Failed to delete export file during cleanup");
            }
          }
          // Delete DB record
          this.db.prepare("DELETE FROM export_tokens WHERE token_hash = ?").run(token.token_hash);
        }
      }
    } catch (err) {
      logger.error({ err }, "Error cleaning up export tokens in reconciliation");
    }
  }
}
