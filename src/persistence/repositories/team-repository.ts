import Database from "better-sqlite3";
import { GitHubTeam } from "../../integrations/github/github-types.js";

export interface DbTeam {
  github_team_id: number;
  github_org_id: number;
  slug: string;
  name: string;
  description: string | null;
  privacy: string;
  parent_team_id: number | null;
  synchronized_flag: number;
  last_refreshed_at: string;
  active_flag: number;
}

export class TeamRepository {
  constructor(private db: Database.Database) {}

  /**
   * Upsert a list of teams in a single transaction.
   */
  upsertTeams(orgId: number, teams: GitHubTeam[], timestamp: string): void {
    const insert = this.db.prepare(`
      INSERT INTO github_teams (
        github_team_id, github_org_id, slug, name, description, privacy, parent_team_id, last_refreshed_at, active_flag
      ) VALUES (
        @github_team_id, @github_org_id, @slug, @name, @description, @privacy, @parent_team_id, @last_refreshed_at, 1
      ) ON CONFLICT(github_team_id) DO UPDATE SET
        github_org_id = excluded.github_org_id,
        slug = excluded.slug,
        name = excluded.name,
        description = excluded.description,
        privacy = excluded.privacy,
        parent_team_id = excluded.parent_team_id,
        last_refreshed_at = excluded.last_refreshed_at,
        active_flag = 1
    `);

    const transaction = this.db.transaction((teamsList: GitHubTeam[]) => {
      for (const team of teamsList) {
        insert.run({
          github_team_id: team.id,
          github_org_id: orgId,
          slug: team.slug,
          name: team.name,
          description: team.description,
          privacy: team.privacy,
          parent_team_id: team.parentTeamId,
          last_refreshed_at: timestamp,
        });
      }
    });

    transaction(teams);
  }

  /**
   * Set active_flag = 0 for all teams except the ones provided, scoped to target Organization.
   */
  markAllInactiveExcept(
    orgId: number,
    activeIds: number[],
    timestamp: string,
  ): void {
    if (activeIds.length === 0) {
      this.db
        .prepare(
          `
        UPDATE github_teams
        SET active_flag = 0, last_refreshed_at = ?
        WHERE github_org_id = ?
      `,
        )
        .run(timestamp, orgId);
      return;
    }
    const placeholders = activeIds.map(() => "?").join(",");
    this.db
      .prepare(
        `
      UPDATE github_teams
      SET active_flag = 0, last_refreshed_at = ?
      WHERE github_org_id = ? AND github_team_id NOT IN (${placeholders})
    `,
      )
      .run(timestamp, orgId, ...activeIds);
  }

  /**
   * Search active teams case-insensitively by name or slug.
   * Prioritizes prefix matches over contains.
   */
  searchTeams(query: string, limit: number = 100): DbTeam[] {
    const likeQuery = `%${query}%`;
    const prefixQuery = `${query}%`;
    return this.db
      .prepare(
        `
      SELECT * FROM github_teams
      WHERE active_flag = 1 AND (name LIKE ? OR slug LIKE ?)
      ORDER BY 
        CASE 
          WHEN name LIKE ? THEN 1
          WHEN slug LIKE ? THEN 2
          ELSE 3
        END,
        name ASC
      LIMIT ?
    `,
      )
      .all(likeQuery, likeQuery, prefixQuery, prefixQuery, limit) as DbTeam[];
  }

  /**
   * List all active teams.
   */
  listActiveTeams(): DbTeam[] {
    return this.db
      .prepare(
        `
      SELECT * FROM github_teams WHERE active_flag = 1
    `,
      )
      .all() as DbTeam[];
  }

  /**
   * Explicitly set the synchronized_flag (IdP sync) for a team.
   */
  setSynchronizedFlag(teamId: number, flag: boolean): void {
    this.db
      .prepare(
        `
      UPDATE github_teams
      SET synchronized_flag = ?
      WHERE github_team_id = ?
    `,
      )
      .run(flag ? 1 : 0, teamId);
  }

  /**
   * Retrieve a single team by ID.
   */
  getTeam(teamId: number): DbTeam | null {
    return this.db
      .prepare(
        `
      SELECT * FROM github_teams WHERE github_team_id = ?
    `,
      )
      .get(teamId) as DbTeam | null;
  }
}
