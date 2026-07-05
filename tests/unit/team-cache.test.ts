import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { runMigrations } from "../../src/persistence/migrations.js";
import { ReconciliationService } from "../../src/services/reconciliation-service.js";
import { TeamRepository } from "../../src/persistence/repositories/team-repository.js";
import { RevocationService } from "../../src/services/revocation-service.js";
import { GitHubOrganizationContext } from "../../src/domain/github-organization-context.js";

describe("Team Cache Synchronization", () => {
  const tempDbPath = path.resolve("./tests/team-cache-test.sqlite");
  let db: Database.Database;
  let teamRepo: TeamRepository;

  const mockGithubClient = {
    listTeams: vi.fn(),
  };

  const mockRevocationService = {
    revoke: vi.fn(),
  } as unknown as RevocationService;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    teamRepo = new TeamRepository(db);
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
    vi.clearAllMocks();
    db.prepare("PRAGMA foreign_keys = OFF").run();
    db.prepare("DELETE FROM github_teams").run();
    db.prepare("DELETE FROM audit_events").run();
    db.prepare("PRAGMA foreign_keys = ON").run();
  });

  it("should synchronize team cache and disable absent teams in db", async () => {
    const mockOrgContext = {
      organizationId: 1111,
      organizationLogin: "test-org",
      installationId: 12345,
    };

    // 1. Prepare initial cache with an old team that will be removed
    const timestampOld = new Date(Date.now() - 3600000).toISOString();
    teamRepo.upsertTeams(
      1111,
      [
        {
          id: 999,
          name: "Old Team",
          slug: "old-team",
          description: "old",
          privacy: "closed",
        },
      ],
      timestampOld,
    );

    // Verify it is active initially
    let oldTeam = teamRepo.getTeam(999);
    expect(oldTeam).not.toBeNull();
    expect(oldTeam!.active_flag).toBe(1);

    // 2. Mock listTeams to return new list of active teams
    mockGithubClient.listTeams.mockResolvedValue([
      {
        id: 100,
        name: "Alpha Team",
        slug: "alpha-team",
        description: "Alpha",
        privacy: "closed",
      },
      {
        id: 200,
        name: "Beta Team",
        slug: "beta-team",
        description: "Beta",
        privacy: "closed",
      },
    ]);

    // 3. Trigger reconciliation sync (starts immediately because lastTeamCacheRefreshAt is 0)
    const reconciliationService = new ReconciliationService(
      db,
      mockGithubClient as any,
      mockRevocationService,
      mockOrgContext,
    );
    await reconciliationService.reconcile();

    expect(mockGithubClient.listTeams).toHaveBeenCalled();

    // 4. Verify new teams are inserted and marked active
    const alpha = teamRepo.getTeam(100);
    const beta = teamRepo.getTeam(200);
    expect(alpha).not.toBeNull();
    expect(alpha!.active_flag).toBe(1);
    expect(beta).not.toBeNull();
    expect(beta!.active_flag).toBe(1);

    // 5. Verify old team is deactivated (active_flag = 0)
    oldTeam = teamRepo.getTeam(999);
    expect(oldTeam).not.toBeNull();
    expect(oldTeam!.active_flag).toBe(0);

    // 6. Verify audit event was written
    const auditEvents = db
      .prepare("SELECT * FROM audit_events WHERE event_type = ?")
      .all("team_cache_synchronized");
    expect(auditEvents).toHaveLength(1);
    expect(JSON.parse((auditEvents[0] as any).payload_json).teamCount).toBe(2);
  });

  it("should rollback transaction and not modify cache if listTeams fails", async () => {
    const mockOrgContext = {
      organizationId: 1111,
      organizationLogin: "test-org",
      installationId: 12345,
    };

    const timestampOld = new Date().toISOString();
    teamRepo.upsertTeams(
      1111,
      [
        {
          id: 999,
          name: "Old Team",
          slug: "old-team",
          description: "old",
          privacy: "closed",
        },
      ],
      timestampOld,
    );

    mockGithubClient.listTeams.mockRejectedValue(
      new Error("GitHub API rate limit or outage"),
    );

    const reconciliationService = new ReconciliationService(
      db,
      mockGithubClient as any,
      mockRevocationService,
      mockOrgContext,
    );
    await reconciliationService.reconcile();

    // Cache should remain untouched
    const oldTeam = teamRepo.getTeam(999);
    expect(oldTeam).not.toBeNull();
    expect(oldTeam!.active_flag).toBe(1);
  });
});
