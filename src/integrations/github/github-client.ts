import { App, Octokit } from "octokit";
import {
  GitHubInstallation,
  GitHubTeam,
  GitHubUser,
  OrganizationMembership,
  TeamMembership,
} from "./github-types.js";
import {
  GitHubError,
  GitHubRateLimitError,
  GitHubIdpSyncError,
  GitHubTransientError,
  GitHubNotFoundError,
  GitHubUnauthorizedError,
} from "../../domain/errors.js";
import { logger } from "../../logger.js";

export interface GitHubAccessProvider {
  resolveInstallation(): Promise<GitHubInstallation>;
  listTeams(query?: string): Promise<GitHubTeam[]>;
  getOrganizationMembership(
    githubUserId: number,
  ): Promise<OrganizationMembership>;
  getTeamMembership(
    teamId: number,
    githubUserId: number,
  ): Promise<TeamMembership | null>;
  addTeamMember(teamId: number, githubUserId: number): Promise<TeamMembership>;
  removeTeamMember(teamId: number, githubUserId: number): Promise<void>;
  getAuthenticatedUser(userAccessToken: string): Promise<GitHubUser>;
}

export interface GitHubClientConfig {
  appId: number;
  privateKey: string;
  clientId: string;
  clientSecret: string;
  org: string;
}

export class GitHubClient implements GitHubAccessProvider {
  private app: App;
  private org: string;
  private installationId: number | null = null;
  private orgId: number | null = null;

  constructor(config: GitHubClientConfig) {
    this.org = config.org;
    this.app = new App({
      appId: config.appId,
      privateKey: config.privateKey,
      oauth: {
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      },
    });
  }

  private async getInstallationClient(): Promise<Octokit> {
    if (this.installationId !== null) {
      return this.app.getInstallationOctokit(this.installationId);
    }

    const inst = await this.resolveInstallation();
    this.installationId = inst.id;
    this.orgId = inst.targetId;
    return this.app.getInstallationOctokit(this.installationId);
  }

  private handleError(error: unknown): never {
    const err = error as {
      status?: number;
      response?: {
        status?: number;
        headers?: Record<string, string | undefined>;
        data?: { message?: string; documentation_url?: string };
      };
      message?: string;
    };
    const status = err.status || err.response?.status;
    const message = err.message || "Unknown GitHub API error";
    const responseData = err.response?.data || {};
    const responseMessage = responseData.message || "";
    const docUrl = responseData.documentation_url || "";

    logger.debug(
      { error, status, message, responseMessage, docUrl },
      "GitHub API error encountered",
    );

    const isIdpSyncMsg = (msg: string) => {
      const lower = msg.toLowerCase();
      return (
        lower.includes("synchronized with an identity provider") ||
        lower.includes("team-synchronization") ||
        lower.includes("manually manage members of a team synchronized")
      );
    };

    if (
      isIdpSyncMsg(message) ||
      isIdpSyncMsg(responseMessage) ||
      docUrl.toLowerCase().includes("team-synchronization")
    ) {
      throw new GitHubIdpSyncError(message || responseMessage);
    }

    // 401 Unauthorized
    if (status === 401) {
      throw new GitHubUnauthorizedError(message);
    }

    // 404 Not Found
    if (status === 404) {
      throw new GitHubNotFoundError(message);
    }

    // 403 Forbidden
    if (status === 403) {
      const resetHeader = err.response?.headers?.["x-ratelimit-reset"];
      const resetTime = resetHeader ? parseInt(resetHeader, 10) : undefined;

      if (
        message.toLowerCase().includes("rate limit") ||
        message.toLowerCase().includes("exceeded") ||
        resetTime !== undefined
      ) {
        throw new GitHubRateLimitError(message, resetTime);
      }

      throw new GitHubError(message, status);
    }

    // 5xx Server Errors or network failures / timeouts
    if (!status || status >= 500) {
      throw new GitHubTransientError(message, status);
    }

    throw new GitHubError(message, status);
  }

  private async getLoginByUserId(
    githubUserId: number,
    octokit: Octokit,
  ): Promise<string> {
    try {
      const response = await octokit.request("GET /user/{account_id}", {
        account_id: githubUserId,
      });
      return response.data.login;
    } catch (error) {
      this.handleError(error);
    }
  }

  async resolveInstallation(): Promise<GitHubInstallation> {
    try {
      const response = await this.app.octokit.request(
        "GET /orgs/{org}/installation",
        {
          org: this.org,
        },
      );
      const data = response.data;

      const account = data.account;
      if (!account || !("login" in account)) {
        throw new Error(
          "Installation account information is missing or invalid.",
        );
      }

      // Store orgId cache
      this.orgId = data.target_id;

      return {
        id: data.id,
        targetId: data.target_id,
        targetType: data.target_type,
        accountLogin: account.login,
      };
    } catch (error) {
      this.handleError(error);
    }
  }

  async listTeams(query?: string): Promise<GitHubTeam[]> {
    try {
      const client = await this.getInstallationClient();
      const rawTeams = await client.paginate("GET /orgs/{org}/teams", {
        org: this.org,
        per_page: 100,
      });

      interface RawTeam {
        id: number;
        name: string;
        slug: string;
        description: string | null;
        privacy?: string;
        parent?: { id: number } | null;
      }
      const teams: GitHubTeam[] = (rawTeams as RawTeam[]).map((team) => ({
        id: team.id,
        name: team.name,
        slug: team.slug,
        description: team.description || null,
        privacy: team.privacy || "closed",
        parentTeamId: team.parent ? team.parent.id : null,
      }));

      if (!query) {
        return teams;
      }

      const lowerQuery = query.toLowerCase();
      return teams.filter(
        (t) =>
          t.name.toLowerCase().includes(lowerQuery) ||
          t.slug.toLowerCase().includes(lowerQuery),
      );
    } catch (error) {
      this.handleError(error);
    }
  }

  async getOrganizationMembership(
    githubUserId: number,
  ): Promise<OrganizationMembership> {
    try {
      const client = await this.getInstallationClient();
      const login = await this.getLoginByUserId(githubUserId, client);

      const response = await client.request(
        "GET /orgs/{org}/memberships/{username}",
        {
          org: this.org,
          username: login,
        },
      );

      return {
        orgId: this.orgId || 0,
        githubUserId,
        githubLogin: login,
        role: (response.data.role === "admin" ? "admin" : "member") as "admin" | "member",
        state: response.data.state,
      };
    } catch (error) {
      this.handleError(error);
    }
  }

  async getTeamMembership(
    teamId: number,
    githubUserId: number,
  ): Promise<TeamMembership | null> {
    try {
      const client = await this.getInstallationClient();
      const login = await this.getLoginByUserId(githubUserId, client);

      try {
        if (!this.orgId) {
          const inst = await this.resolveInstallation();
          this.orgId = inst.targetId;
        }

        const response = await client.request(
          "GET /organizations/{org_id}/team/{team_id}/memberships/{username}",
          {
            org_id: this.orgId,
            team_id: teamId,
            username: login,
          },
        );

        return {
          teamId,
          githubUserId,
          githubLogin: login,
          role: response.data.state === "pending" ? "pending" : response.data.role,
        };
      } catch (innerError) {
        const status = (innerError as { status?: number }).status;
        if (status === 404) {
          return null; // Not a member
        }
        throw innerError;
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  async addTeamMember(
    teamId: number,
    githubUserId: number,
  ): Promise<TeamMembership> {
    try {
      const client = await this.getInstallationClient();
      const login = await this.getLoginByUserId(githubUserId, client);

      if (!this.orgId) {
        const inst = await this.resolveInstallation();
        this.orgId = inst.targetId;
      }

      const response = await client.request(
        "PUT /organizations/{org_id}/team/{team_id}/memberships/{username}",
        {
          org_id: this.orgId,
          team_id: teamId,
          username: login,
          role: "member",
        },
      );

      return {
        teamId,
        githubUserId,
        githubLogin: login,
        role: response.data.role,
      };
    } catch (error) {
      this.handleError(error);
    }
  }

  async removeTeamMember(teamId: number, githubUserId: number): Promise<void> {
    try {
      const client = await this.getInstallationClient();
      const login = await this.getLoginByUserId(githubUserId, client);

      if (!this.orgId) {
        const inst = await this.resolveInstallation();
        this.orgId = inst.targetId;
      }

      await client.request(
        "DELETE /organizations/{org_id}/team/{team_id}/memberships/{username}",
        {
          org_id: this.orgId,
          team_id: teamId,
          username: login,
        },
      );
    } catch (error) {
      const err = error as { status?: number; response?: { status?: number } };
      const status = err.status || err.response?.status;
      if (status === 404) {
        return; // Idempotent delete
      }
      this.handleError(error);
    }
  }

  async getAuthenticatedUser(userAccessToken: string): Promise<GitHubUser> {
    try {
      const userOctokit = new Octokit({ auth: userAccessToken });
      const response = await userOctokit.request("GET /user");
      const data = response.data;
      return {
        id: data.id,
        login: data.login,
        name: data.name || null,
        email: data.email || null,
      };
    } catch (error) {
      this.handleError(error);
    }
  }
}
