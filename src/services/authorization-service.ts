import { GitHubAccessProvider } from "../integrations/github/github-client.js";

export interface ApprovalAuthority {
  authorized: boolean;
  authorityRole: "team_maintainer" | "org_owner" | null;
  githubUserId: number;
  verifiedAt: string;
}

export class AuthorizationService {
  constructor(private githubClient: GitHubAccessProvider) {}

  /**
   * Verifies if the user is authorized to approve or deny requests for the target team.
   * Authorized roles: Team Maintainer or Organization Owner (role = admin & state = active).
   */
  async verifyRequestDecisionAuthority(params: {
    targetTeamId: number;
    githubUserId: number;
  }): Promise<ApprovalAuthority> {
    const { targetTeamId, githubUserId } = params;
    const timestamp = new Date().toISOString();

    // 1. Check if user is a maintainer of the target team
    let teamRole: string | null = null;
    try {
      const membership = await this.githubClient.getTeamMembership(
        targetTeamId,
        githubUserId,
      );
      teamRole = membership ? membership.role : null;
    } catch (err) {
      if ((err as Error).name !== "GitHubNotFoundError") {
        throw err;
      }
    }

    if (teamRole === "maintainer") {
      return {
        authorized: true,
        authorityRole: "team_maintainer",
        githubUserId,
        verifiedAt: timestamp,
      };
    }

    // 2. Check if user is an Org Owner (role = admin and state = active)
    let isOrgOwner = false;
    try {
      const orgMembership =
        await this.githubClient.getOrganizationMembership(githubUserId);
      isOrgOwner = orgMembership
        ? orgMembership.state === "active" && orgMembership.role === "admin"
        : false;
    } catch (err) {
      if ((err as Error).name !== "GitHubNotFoundError") {
        throw err;
      }
    }

    if (isOrgOwner) {
      return {
        authorized: true,
        authorityRole: "org_owner",
        githubUserId,
        verifiedAt: timestamp,
      };
    }

    return {
      authorized: false,
      authorityRole: null,
      githubUserId,
      verifiedAt: timestamp,
    };
  }
}
