import Database from "better-sqlite3";
import crypto from "crypto";
import { RequestRepository } from "../persistence/repositories/request-repository.js";
import { GrantRepository } from "../persistence/repositories/grant-repository.js";
import { JobRepository } from "../persistence/repositories/job-repository.js";
import { ApprovalRepository } from "../persistence/repositories/approval-repository.js";
import { IdentityRepository } from "../persistence/repositories/identity-repository.js";
import { AuditRepository } from "../persistence/repositories/audit-repository.js";

export interface CreateGrantIntentParams {
  requestId: string;
  decisionMode: "manual" | "auto";
  approverIdentityId?: string | null;
  approverGithubUserId?: number | null;
  authorityRole?: string | null;
  decisionReason?: string | null;
  matchedPolicyId?: string | null;
  matchedPolicyVersion?: number | null;
}

export class GrantService {
  constructor(private db: Database.Database) {}

  /**
   * Transition request to approved status, link/create active grant, and enqueue grant_access job
   * atomically in a database transaction.
   */
  createGrantIntentTx(params: CreateGrantIntentParams): { grantId: string } {
    const timestamp = new Date().toISOString();
    const requestRepo = new RequestRepository(this.db);
    const grantRepo = new GrantRepository(this.db);
    const jobRepo = new JobRepository(this.db);
    const approvalRepo = new ApprovalRepository(this.db);
    const identityRepo = new IdentityRepository(this.db);

    const transaction = this.db.transaction(() => {
      // 1. Fetch access request
      const request = requestRepo.getRequest(params.requestId);
      if (!request) {
        throw new Error(`Access request ${params.requestId} not found`);
      }

      // 2. Perform Compare-and-Set Status update to 'approved'
      const changes = requestRepo.updateDecisionStatus(
        params.requestId,
        "approved",
        params.decisionMode,
        timestamp,
        null,
      );

      if (changes !== 1) {
        throw new Error(
          `Failed to approve request ${params.requestId}: status is not pending (potential concurrent update)`,
        );
      }

      // 3. Insert approval record if manual decision
      if (params.decisionMode === "manual") {
        if (
          !params.approverIdentityId ||
          !params.approverGithubUserId ||
          !params.authorityRole
        ) {
          throw new Error("Missing approver details for manual decision");
        }
        approvalRepo.createApproval({
          id: crypto.randomUUID(),
          accessRequestId: params.requestId,
          decision: "approved",
          approverIdentityId: params.approverIdentityId,
          approverGithubUserId: params.approverGithubUserId,
          authorityRole: params.authorityRole,
          authorityVerifiedAt: timestamp,
          reason: params.decisionReason || null,
          createdAt: timestamp,
        });
      }

      // Update matched policy info on request if provided
      if (params.matchedPolicyId && params.matchedPolicyVersion) {
        requestRepo.updatePolicyInfo(
          params.requestId,
          params.matchedPolicyId,
          params.matchedPolicyVersion,
        );
      }

      // 4. Fetch requester identity details
      const requesterLink = identityRepo.getLink(request.requester_identity_id);
      if (!requesterLink) {
        throw new Error(
          `Requester identity link ${request.requester_identity_id} not found`,
        );
      }

      // 5. Expiration Calculation
      const requestedExpiresAt = new Date(
        Date.now() + request.duration_minutes * 60 * 1000,
      ).toISOString();

      // 6. Find existing active grant for (org, team, user)
      const grant = grantRepo.findActiveGrant(
        request.github_org_id,
        request.target_team_id,
        requesterLink.github_user_id,
      );

      let grantId: string;
      let shouldEnqueueJob = false;

      if (grant) {
        grantId = grant.id;
        // Extend effective expiration if the new request expires later
        const currentExpires = new Date(grant.effective_expires_at).getTime();
        const newExpires = new Date(requestedExpiresAt).getTime();
        if (newExpires > currentExpires) {
          grantRepo.updateGrantExpiresAt(grantId, requestedExpiresAt);

          const auditRepo = new AuditRepository(this.db);
          auditRepo.writeEventTx({
            eventType: "grant.expiration_extended",
            actorType: params.decisionMode === "auto" ? "system" : "user",
            actorId: params.approverIdentityId || null,
            githubOrgId: request.github_org_id,
            githubUserId: requesterLink.github_user_id,
            githubTeamId: request.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              previous_expires_at: grant.effective_expires_at,
              new_expires_at: requestedExpiresAt,
            }),
          });
        }

        // Link request to the existing grant
        grantRepo.createGrantRequest(grantId, request.id, requestedExpiresAt);

        // If the existing grant has not been fulfilled yet, ensure the job will run
        if (grant.status === "pending") {
          shouldEnqueueJob = true;
        } else if (
          grant.status === "revoking" ||
          grant.status === "revoke_failed"
        ) {
          // Reactivate the grant by resetting to pending and setting reactivation_required
          const currentExpires = new Date(grant.effective_expires_at).getTime();
          const newExpires = new Date(requestedExpiresAt).getTime();
          const targetExpires =
            newExpires > currentExpires
              ? requestedExpiresAt
              : grant.effective_expires_at;

          grantRepo.reactivateGrant(
            grantId,
            targetExpires,
            "reactivation_required",
          );
          shouldEnqueueJob = true;

          const auditRepo = new AuditRepository(this.db);
          auditRepo.writeEventTx({
            eventType: "grant.reactivated",
            actorType: params.decisionMode === "auto" ? "system" : "user",
            actorId: params.approverIdentityId || null,
            githubOrgId: request.github_org_id,
            githubUserId: requesterLink.github_user_id,
            githubTeamId: request.target_team_id,
            grantId,
            payloadJson: JSON.stringify({
              previous_status: grant.status,
              extended_expires_at: targetExpires,
            }),
          });
        }
      } else {
        // Create new active grant
        grantId = crypto.randomUUID();
        grantRepo.createGrant({
          id: grantId,
          githubOrgId: request.github_org_id,
          targetTeamId: request.target_team_id,
          githubUserId: requesterLink.github_user_id,
          githubLoginSnapshot: requesterLink.github_login,
          status: "pending", // Initially pending until job completes
          membershipCreatedByApp: 1, // Defaulting to 1 (managed)
          preexistingRole: null,
          grantedAt: null,
          effectiveExpiresAt: requestedExpiresAt,
          createdAt: timestamp,
          updatedAt: timestamp,
          membershipMutationState: "not_started",
          membershipAddAttemptedAt: null,
          membershipAddOperationId: null,
          membershipAddLastVerifiedAt: null,
        });

        // Link request to the new grant
        grantRepo.createGrantRequest(grantId, request.id, requestedExpiresAt);
        shouldEnqueueJob = true;
      }

      // 7. Enqueue non-blocking grant_access job if required
      if (shouldEnqueueJob) {
        const jobId = crypto.randomUUID();
        jobRepo.createJob({
          id: jobId,
          type: "grant_access",
          payloadJson: JSON.stringify({ grantId }),
          runAfter: timestamp,
        });
      }

      // 8. Write Audit Event
      const auditRepo = new AuditRepository(this.db);
      auditRepo.writeEventTx({
        eventType: "request_approved",
        actorType: params.decisionMode === "auto" ? "system" : "user",
        actorId: params.approverIdentityId || null,
        slackWorkspaceId: request.slack_workspace_id,
        slackUserId: params.approverIdentityId
          ? identityRepo.getLink(params.approverIdentityId)?.slack_user_id
          : null,
        githubOrgId: request.github_org_id,
        githubUserId: requesterLink.github_user_id,
        githubTeamId: request.target_team_id,
        accessRequestId: request.id,
        grantId,
        policyId: params.matchedPolicyId || null,
        policyVersion: params.matchedPolicyVersion || null,
        payloadJson: JSON.stringify({
          decisionMode: params.decisionMode,
          decisionReason: params.decisionReason,
          durationMinutes: request.duration_minutes,
        }),
      });

      return { grantId };
    });

    return transaction();
  }
}
