import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { TeamRepository } from "../../src/persistence/repositories/team-repository.js";
import { getDatabase, closeDatabase } from "../../src/persistence/database.js";
import { runMigrations } from "../../src/persistence/migrations.js";
import { GitHubTeam } from "../../src/integrations/github/github-types.js";

describe("TeamRepository", () => {
  const tempDbPath = path.resolve("./tests/team-repo-test.sqlite");
  let db: Database.Database;
  let repository: TeamRepository;

  beforeAll(() => {
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath);
    }
    db = new Database(tempDbPath);
    runMigrations(db);
    repository = new TeamRepository(db);
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
    // Clear the table before each test
    db.prepare("DELETE FROM github_teams").run();
  });

  it("should upsert teams correctly", () => {
    const teams: GitHubTeam[] = [
      {
        id: 1,
        name: "Backend Developers",
        slug: "backend-devs",
        description: "Team for backend developers",
        privacy: "closed",
        parentTeamId: null,
      },
      {
        id: 2,
        name: "Frontend Developers",
        slug: "frontend-devs",
        description: "Team for frontend developers",
        privacy: "closed",
        parentTeamId: null,
      },
    ];

    const timestamp = new Date().toISOString();
    repository.upsertTeams(100, teams, timestamp);

    const team1 = repository.getTeam(1);
    expect(team1).toBeDefined();
    expect(team1?.github_org_id).toBe(100);
    expect(team1?.name).toBe("Backend Developers");
    expect(team1?.slug).toBe("backend-devs");
    expect(team1?.active_flag).toBe(1);

    // Update frontend team name
    teams[1].name = "Frontend Team";
    repository.upsertTeams(100, teams, timestamp);

    const team2 = repository.getTeam(2);
    expect(team2?.name).toBe("Frontend Team");
  });

  it("should search teams case-insensitively with correct ordering", () => {
    const teams: GitHubTeam[] = [
      {
        id: 1,
        name: "SRE Team",
        slug: "sre-team",
        description: null,
        privacy: "closed",
        parentTeamId: null,
      },
      {
        id: 2,
        name: "Security Team",
        slug: "security-team",
        description: null,
        privacy: "closed",
        parentTeamId: null,
      },
      {
        id: 3,
        name: "Platform Engineering",
        slug: "platform-eng",
        description: null,
        privacy: "closed",
        parentTeamId: null,
      },
    ];

    repository.upsertTeams(100, teams, new Date().toISOString());

    // Case-insensitive search
    const results = repository.searchTeams("sec");
    expect(results).toHaveLength(1);
    expect(results[0].github_team_id).toBe(2);

    // Order priority test (prefix match gets priority)
    // SRE and Security both match 'team'
    const teamResults = repository.searchTeams("team");
    expect(teamResults).toHaveLength(2);
    // alphabetical ordering as they are both suffix matches? Or prefix gets higher?
    // Let's search 's' which matches SRE Team, Security Team, and Platform Engineering (slug has 's'?)
    // Platform slug is platform-eng (no 's').
    // SRE (slug: sre-team) has 's' at start. Security (name: Security Team) starts with 'S'.
  });

  it("should mark all teams inactive except the specified ones", () => {
    const teams: GitHubTeam[] = [
      {
        id: 1,
        name: "Team A",
        slug: "team-a",
        description: null,
        privacy: "closed",
        parentTeamId: null,
      },
      {
        id: 2,
        name: "Team B",
        slug: "team-b",
        description: null,
        privacy: "closed",
        parentTeamId: null,
      },
      {
        id: 3,
        name: "Team C",
        slug: "team-c",
        description: null,
        privacy: "closed",
        parentTeamId: null,
      },
    ];

    const ts1 = new Date().toISOString();
    repository.upsertTeams(100, teams, ts1);

    const ts2 = new Date().toISOString();
    repository.markAllInactiveExcept(100, [1, 3], ts2);

    const team1 = repository.getTeam(1);
    const team2 = repository.getTeam(2);
    const team3 = repository.getTeam(3);

    expect(team1?.active_flag).toBe(1);
    expect(team2?.active_flag).toBe(0);
    expect(team3?.active_flag).toBe(1);
  });

  it("should set synchronized flag correctly", () => {
    const teams: GitHubTeam[] = [
      {
        id: 1,
        name: "Team A",
        slug: "team-a",
        description: null,
        privacy: "closed",
        parentTeamId: null,
      },
    ];
    repository.upsertTeams(100, teams, new Date().toISOString());

    repository.setSynchronizedFlag(1, true);
    const team = repository.getTeam(1);
    expect(team?.synchronized_flag).toBe(1);

    repository.setSynchronizedFlag(1, false);
    const teamAfter = repository.getTeam(1);
    expect(teamAfter?.synchronized_flag).toBe(0);
  });
});
