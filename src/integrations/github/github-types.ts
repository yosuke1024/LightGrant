/**
 * Represents a GitHub App installation for an organization.
 */
export interface GitHubInstallation {
  id: number;
  targetId: number; // Organization ID
  targetType: string; // "Organization"
  accountLogin: string; // Organization login name
}

/**
 * Represents a GitHub Team within the organization.
 */
export interface GitHubTeam {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  privacy: string;
  parentTeamId: number | null;
  synchronizedFlag?: boolean;
}

/**
 * Represents a GitHub User.
 */
export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

/**
 * Represents membership in the GitHub Organization.
 */
export interface OrganizationMembership {
  orgId: number;
  githubUserId: number;
  githubLogin: string;
  role: "admin" | "member";
  state: "active" | "pending";
}

/**
 * Represents membership in a specific GitHub Team.
 */
export interface TeamMembership {
  teamId: number;
  githubUserId: number;
  githubLogin: string;
  role: "maintainer" | "member" | "pending";
}
