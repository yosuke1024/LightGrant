import {
  GitHubAccessProvider,
  GitHubInstallation,
  GitHubTeam,
  GitHubUser,
  OrganizationMembership,
  TeamMembership,
} from "../../src/integrations/github/github-types.js";
import {
  GitHubError,
  GitHubRateLimitError,
  GitHubIdpSyncError,
  GitHubTransientError,
  GitHubNotFoundError,
  GitHubUnauthorizedError,
} from "../../src/domain/errors.js";

export class FakeGitHubClient implements GitHubAccessProvider {
  public installation: GitHubInstallation | null = null;
  public teams: GitHubTeam[] = [];
  public orgMembers: OrganizationMembership[] = [];
  public teamMembers: TeamMembership[] = [];
  public authenticatedUsers: Map<string, GitHubUser> = new Map();

  // Settings for error simulation
  public simulateRateLimit = false;
  public simulateTransientError = false;
  public idpSyncTeams: Set<number> = new Set();

  // Call history tracking
  public calls: { method: string; args: any[] }[] = [];

  private recordCall(method: string, ...args: any[]): void {
    this.calls.push({ method, args });

    if (this.simulateRateLimit) {
      throw new GitHubRateLimitError(
        "Rate limit exceeded",
        Math.floor(Date.now() / 1000) + 60,
      );
    }
    if (this.simulateTransientError) {
      throw new GitHubTransientError(
        "Transient error: Connection reset by peer",
        503,
      );
    }
  }

  async resolveInstallation(): Promise<GitHubInstallation> {
    this.recordCall("resolveInstallation");
    if (!this.installation) {
      throw new GitHubNotFoundError(
        "No installation found for the specified organization.",
      );
    }
    return this.installation;
  }

  async listTeams(query?: string): Promise<GitHubTeam[]> {
    this.recordCall("listTeams", query);
    if (!query) {
      return this.teams;
    }
    const lowerQuery = query.toLowerCase();
    return this.teams.filter(
      (team) =>
        team.name.toLowerCase().includes(lowerQuery) ||
        team.slug.toLowerCase().includes(lowerQuery),
    );
  }

  async getOrganizationMembership(
    githubUserId: number,
  ): Promise<OrganizationMembership> {
    this.recordCall("getOrganizationMembership", githubUserId);
    const member = this.orgMembers.find((m) => m.githubUserId === githubUserId);
    if (!member) {
      throw new GitHubNotFoundError(
        `User with ID ${githubUserId} is not a member of the organization.`,
      );
    }
    return member;
  }

  async getTeamMembership(
    teamId: number,
    githubUserId: number,
  ): Promise<TeamMembership | null> {
    this.recordCall("getTeamMembership", teamId, githubUserId);
    const membership = this.teamMembers.find(
      (m) => m.teamId === teamId && m.githubUserId === githubUserId,
    );
    return membership || null;
  }

  async addTeamMember(
    teamId: number,
    githubUserId: number,
  ): Promise<TeamMembership> {
    this.recordCall("addTeamMember", teamId, githubUserId);

    if (this.idpSyncTeams.has(teamId)) {
      throw new GitHubIdpSyncError(
        `Team ${teamId} is managed by an identity provider.`,
      );
    }

    // Requester must be an active org member
    const orgMember = this.orgMembers.find(
      (m) => m.githubUserId === githubUserId,
    );
    if (!orgMember || orgMember.state !== "active") {
      throw new GitHubError(
        `User ${githubUserId} is not an active organization member. Cannot add to team.`,
        403,
      );
    }

    const existing = this.teamMembers.find(
      (m) => m.teamId === teamId && m.githubUserId === githubUserId,
    );
    if (existing) {
      return existing;
    }

    const newMembership: TeamMembership = {
      teamId,
      githubUserId,
      githubLogin: orgMember.githubLogin,
      role: "member",
    };
    this.teamMembers.push(newMembership);
    return newMembership;
  }

  async removeTeamMember(teamId: number, githubUserId: number): Promise<void> {
    this.recordCall("removeTeamMember", teamId, githubUserId);

    if (this.idpSyncTeams.has(teamId)) {
      throw new GitHubIdpSyncError(
        `Team ${teamId} is managed by an identity provider.`,
      );
    }

    this.teamMembers = this.teamMembers.filter(
      (m) => !(m.teamId === teamId && m.githubUserId === githubUserId),
    );
  }

  async getAuthenticatedUser(userAccessToken: string): Promise<GitHubUser> {
    this.recordCall("getAuthenticatedUser", userAccessToken);
    const user = this.authenticatedUsers.get(userAccessToken);
    if (!user) {
      throw new GitHubUnauthorizedError("Bad credentials");
    }
    return user;
  }
}
