import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { AuditRepository } from "../persistence/repositories/audit-repository.js";
import { config } from "../config.js";
import { logger } from "../logger.js";

export class AuditExportService {
  private auditRepo: AuditRepository;

  constructor(private db: Database.Database) {
    this.auditRepo = new AuditRepository(db);
  }

  /**
   * Export all audit events to a CSV file and return a one-time download URL.
   */
  async exportToCsv(params: {
    slackWorkspaceId: string;
    slackUserId: string;
    githubUserId?: number;
    isAdmin: boolean;
  }): Promise<{ downloadUrl: string; token: string }> {
    const exportDir =
      process.env.NODE_ENV === "test"
        ? path.resolve("./data/audit_exports")
        : "/data/exports";

    if (!fs.existsSync(exportDir)) {
      fs.mkdirSync(exportDir, { recursive: true });
    }

    // 1. Generate secure one-time tokens and independent file identity
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const fileId = crypto.randomUUID();
    const filePath = path.resolve(exportDir, `${fileId}.csv`);

    // 2. Fetch and format events to CSV
    let allowedTeamIds: number[] | null = null;

    if (!params.isAdmin && params.githubUserId) {
      const githubClient = new (
        await import("../integrations/github/github-client.js")
      ).GitHubClient({
        appId: config.GITHUB_APP_ID,
        privateKey: config.GITHUB_PRIVATE_KEY_BASE64,
        clientId: config.GITHUB_CLIENT_ID,
        clientSecret: config.GITHUB_CLIENT_SECRET,
        org: config.GITHUB_ORG,
      });

      const authService = new (
        await import("./authorization-service.js")
      ).AuthorizationService(githubClient);

      const teamRepo = new (
        await import("../persistence/repositories/team-repository.js")
      ).TeamRepository(this.db);

      const activeTeams = teamRepo.listActiveTeams();
      allowedTeamIds = [];

      for (const team of activeTeams) {
        const authResult = await authService.verifyRequestDecisionAuthority({
          targetTeamId: team.github_team_id,
          githubUserId: params.githubUserId,
        });
        if (authResult.authorized) {
          allowedTeamIds.push(team.github_team_id);
        }
      }
    }

    let events = this.auditRepo.listAllEvents();
    if (allowedTeamIds !== null) {
      events = events.filter(
        (e) =>
          e.github_team_id !== null &&
          allowedTeamIds!.includes(e.github_team_id),
      );
    }
    const csvHeaders = [
      "Sequence",
      "EventID",
      "EventType",
      "OccurredAt",
      "ActorType",
      "ActorID",
      "SlackWorkspaceID",
      "SlackUserID",
      "GitHubOrgID",
      "GitHubUserID",
      "GitHubTeamID",
      "AccessRequestID",
      "GrantID",
      "PolicyID",
      "PolicyVersion",
      "CorrelationID",
      "PayloadJSON",
      "PreviousHash",
      "EventHash",
      "CreatedAt",
    ];

    const csvRows = [csvHeaders.join(",")];

    for (const e of events) {
      const row = [
        e.sequence_number,
        e.event_id,
        e.event_type,
        e.occurred_at,
        e.actor_type,
        e.actor_id || "",
        e.slack_workspace_id || "",
        e.slack_user_id || "",
        e.github_org_id || "",
        e.github_user_id || "",
        e.github_team_id || "",
        e.access_request_id || "",
        e.grant_id || "",
        e.policy_id || "",
        e.policy_version || "",
        e.correlation_id,
        this.escapeCsvField(e.payload_json),
        e.previous_hash || "",
        e.event_hash,
        e.created_at,
      ];
      csvRows.push(row.map((val) => `"${val}"`).join(","));
    }

    const csvContent = csvRows.join("\n");

    // 3. Write CSV to file
    fs.writeFileSync(filePath, csvContent, "utf8");
    logger.info({ filePath }, "Successfully wrote audit log CSV export file");

    // 4. Save token to DB (valid for 10 minutes)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    this.auditRepo.createExportToken({
      tokenHash,
      slackWorkspaceId: params.slackWorkspaceId,
      slackUserId: params.slackUserId,
      filePath,
      expiresAt,
      fileId,
    });

    const downloadUrl = `${config.PUBLIC_BASE_URL}/audit/export?token=${token}`;
    return { downloadUrl, token };
  }

  private escapeCsvField(val: unknown): string {
    const str = typeof val === "string" ? val : JSON.stringify(val);
    // Escape double quotes inside CSV fields
    return str.replace(/"/g, '""');
  }
}
