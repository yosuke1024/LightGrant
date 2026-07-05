/**
 * Base class for all GitHub integration errors.
 */
export class GitHubError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when GitHub API rate limit is exceeded.
 */
export class GitHubRateLimitError extends GitHubError {
  constructor(
    message: string,
    public readonly resetTimeEpochSeconds?: number,
  ) {
    super(message, 403);
    this.name = "GitHubRateLimitError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when trying to modify membership on an IdP-synchronized team.
 */
export class GitHubIdpSyncError extends GitHubError {
  constructor(message: string) {
    super(message, 403);
    this.name = "GitHubIdpSyncError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown on temporary network issues, timeouts, or 5xx server errors.
 */
export class GitHubTransientError extends GitHubError {
  constructor(message: string, status?: number) {
    super(message, status);
    this.name = "GitHubTransientError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a resource (e.g. organization, team, user) is not found.
 */
export class GitHubNotFoundError extends GitHubError {
  constructor(message: string) {
    super(message, 404);
    this.name = "GitHubNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when authentication or authorization fails.
 */
export class GitHubUnauthorizedError extends GitHubError {
  constructor(message: string) {
    super(message, 401);
    this.name = "GitHubUnauthorizedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
