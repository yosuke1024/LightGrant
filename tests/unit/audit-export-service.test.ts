import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { runMigrations } from "../../src/persistence/migrations.js";
import { AuditRepository } from "../../src/persistence/repositories/audit-repository.js";
import { TeamRepository } from "../../src/persistence/repositories/team-repository.js";
import { AuditExportService } from "../../src/services/audit-export-service.js";

// Mock GitHub API calls in AuthorizationService
vi.mock("../../src/services/authorization-service.js", () => {
  return {
    AuthorizationService: vi.fn().mockImplementation(() => {
      return {
        verifyRequestDecisionAuthority: vi
          .fn()
          .mockImplementation(async ({ targetTeamId, githubUserId }) => {
            // Mocking: User 999 is maintainer of team 111, but not 222
            if (githubUserId === 999 && targetTeamId === 111) {
              return { authorized: true, role: "maintainer" };
            }
            return { authorized: false, role: "member" };
          }),
      };
    }),
  };
});

describe("AuditExportService", () => {
  const tempDbPath = path.resolve("./tests/audit-export-service-test.sqlite");
  let db: Database.Database;
  let auditRepo: AuditRepository;
  let teamRepo: TeamRepository;
  let service: AuditExportService;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    process.env.DATABASE_PATH = tempDbPath;
    process.env.APP_SECRET = "a".repeat(32);
    process.env.PUBLIC_BASE_URL = "https://example.com";
    process.env.ADMIN_SLACK_USER_IDS = "U_ADMIN";

    db = new Database(tempDbPath);
    runMigrations(db);
    auditRepo = new AuditRepository(db);
    teamRepo = new TeamRepository(db);
    service = new AuditExportService(db);
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
  });

  beforeEach(() => {
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("DELETE FROM github_teams").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should export all events for workspace Admin", async () => {
    const timestamp = new Date().toISOString();

    // Seed some audit events
    auditRepo.writeEventTx({
      eventType: "test.event_team1",
      actorType: "user",
      githubTeamId: 111,
      payloadJson: "{}",
    });
    auditRepo.writeEventTx({
      eventType: "test.event_team2",
      actorType: "user",
      githubTeamId: 222,
      payloadJson: "{}",
    });

    const { downloadUrl, token } = await service.exportToCsv({
      slackWorkspaceId: "W123",
      slackUserId: "U_ADMIN", // Admin user
      githubUserId: 999,
      isAdmin: true,
    });

    expect(downloadUrl).toContain("/audit/export?token=");
    expect(token).toBeDefined();

    // Verify token was saved
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const tokenDetails = auditRepo.getExportToken(tokenHash);
    expect(tokenDetails).toBeDefined();

    // Read exported CSV contents
    const csvContent = fs.readFileSync(tokenDetails!.file_path, "utf8");
    expect(csvContent).toContain("test.event_team1");
    expect(csvContent).toContain("test.event_team2");

    // Clean up file
    fs.unlinkSync(tokenDetails!.file_path);
  });

  it("should restrict scope to maintainer team events for Team Maintainer", async () => {
    const timestamp = new Date().toISOString();

    // Seed teams
    teamRepo.upsertTeams(
      1000,
      [
        {
          id: 111,
          name: "Team 111",
          slug: "team-111",
          description: "",
          privacy: "closed",
        },
        {
          id: 222,
          name: "Team 222",
          slug: "team-222",
          description: "",
          privacy: "closed",
        },
      ],
      timestamp,
    );

    // Seed audit events
    auditRepo.writeEventTx({
      eventType: "test.event_team1",
      actorType: "user",
      githubTeamId: 111,
      payloadJson: "{}",
    });
    auditRepo.writeEventTx({
      eventType: "test.event_team2",
      actorType: "user",
      githubTeamId: 222,
      payloadJson: "{}",
    });

    const { downloadUrl, token } = await service.exportToCsv({
      slackWorkspaceId: "W123",
      slackUserId: "U_MEMBER",
      githubUserId: 999, // Maintainer of 111, not 222
      isAdmin: false,
    });

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const tokenDetails = auditRepo.getExportToken(tokenHash);

    const csvContent = fs.readFileSync(tokenDetails!.file_path, "utf8");
    // Should contain Team 111 events but NOT Team 222 events
    expect(csvContent).toContain("test.event_team1");
    expect(csvContent).not.toContain("test.event_team2");

    // Clean up file
    fs.unlinkSync(tokenDetails!.file_path);
  });
});
