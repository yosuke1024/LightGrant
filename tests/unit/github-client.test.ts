import { describe, it, expect, vi, beforeEach } from "vitest";
import { GitHubClient } from "../../src/integrations/github/github-client.js";
import {
  GitHubRateLimitError,
  GitHubIdpSyncError,
  GitHubNotFoundError,
  GitHubUnauthorizedError,
  GitHubTransientError,
} from "../../src/domain/errors.js";

// Hoist mock request function so it is available inside vi.mock
const mockRequest = vi.hoisted(() => vi.fn());
const mockPaginate = vi.hoisted(() => vi.fn());

vi.mock("octokit", () => {
  const MockApp = vi.fn().mockImplementation(() => {
    return {
      octokit: {
        request: mockRequest,
      },
      getInstallationOctokit: vi.fn().mockResolvedValue({
        request: mockRequest,
        paginate: mockPaginate,
      }),
    };
  });

  const MockOctokit = vi.fn().mockImplementation(() => {
    return {
      request: mockRequest,
    };
  });

  return {
    App: MockApp,
    Octokit: MockOctokit,
  };
});

describe("GitHubClient", () => {
  let client: GitHubClient;

  beforeEach(() => {
    // mockReset clears call history AND mock behavior/resolved values
    mockRequest.mockReset();
    mockPaginate.mockReset();

    // Create client instance
    client = new GitHubClient({
      appId: 12345,
      privateKey: "dummy-private-key",
      clientId: "dummy-client-id",
      clientSecret: "dummy-client-secret",
      org: "test-org",
    });
  });

  it("should resolve installation ID correctly", async () => {
    mockRequest.mockResolvedValueOnce({
      data: {
        id: 98765,
        target_id: 1111,
        target_type: "Organization",
        account: { login: "test-org" },
      },
    });

    const inst = await client.resolveInstallation();
    expect(inst.id).toBe(98765);
    expect(inst.targetId).toBe(1111);
    expect(inst.accountLogin).toBe("test-org");
  });

  it("should list teams correctly", async () => {
    // Resolve installation request mock first
    mockRequest.mockResolvedValueOnce({
      data: {
        id: 98765,
        target_id: 1111,
        target_type: "Organization",
        account: { login: "test-org" },
      },
    });
    // List teams request mock using paginate
    mockPaginate.mockResolvedValueOnce([
      {
        id: 1,
        name: "Team Alpha",
        slug: "team-alpha",
        description: "Desc A",
        privacy: "closed",
        parent: null,
      },
      {
        id: 2,
        name: "Team Beta",
        slug: "team-beta",
        description: "Desc B",
        privacy: "closed",
        parent: { id: 1 },
      },
    ]);

    const teams = await client.listTeams();
    expect(teams).toHaveLength(2);
    expect(teams[0].name).toBe("Team Alpha");
    expect(teams[1].parentTeamId).toBe(1);
  });

  it("should handle rate limit errors correctly", async () => {
    const rateLimitError = new Error("API rate limit exceeded");
    (rateLimitError as any).status = 403;
    (rateLimitError as any).response = {
      headers: {
        "x-ratelimit-reset": "1800000000",
      },
    };
    mockRequest.mockRejectedValueOnce(rateLimitError);

    await expect(client.resolveInstallation()).rejects.toThrow(
      GitHubRateLimitError,
    );
  });

  it("should handle IdP sync errors correctly", async () => {
    // Resolve installation mock
    mockRequest.mockResolvedValueOnce({
      data: {
        id: 98765,
        target_id: 1111,
        target_type: "Organization",
        account: { login: "test-org" },
      },
    });

    // Resolve user ID mock
    mockRequest.mockResolvedValueOnce({ data: { login: "test-user" } });

    // Mock team membership add rejecting with IdP sync restriction
    const idpError = new Error(
      "Cannot modify team membership because team is synchronized with an identity provider",
    );
    (idpError as any).status = 403;
    mockRequest.mockRejectedValueOnce(idpError);

    await expect(client.addTeamMember(1, 999)).rejects.toThrow(
      GitHubIdpSyncError,
    );
  });

  it("should handle IdP sync errors correctly with 422 and documentation_url", async () => {
    mockRequest.mockResolvedValueOnce({
      data: {
        id: 98765,
        target_id: 1111,
        target_type: "Organization",
        account: { login: "test-org" },
      },
    });

    mockRequest.mockResolvedValueOnce({ data: { login: "test-user" } });

    const idpError = new Error("Unprocessable Entity");
    (idpError as any).status = 422;
    (idpError as any).response = {
      data: {
        message: "Validation Failed",
        documentation_url:
          "https://docs.github.com/articles/team-synchronization",
      },
    };
    mockRequest.mockRejectedValueOnce(idpError);

    await expect(client.addTeamMember(1, 999)).rejects.toThrow(
      GitHubIdpSyncError,
    );
  });

  it("should resolve user ID to user name and add team member", async () => {
    // Resolve installation mock
    mockRequest.mockResolvedValueOnce({
      data: {
        id: 98765,
        target_id: 1111,
        target_type: "Organization",
        account: { login: "test-org" },
      },
    });

    // User resolution request mock
    mockRequest.mockResolvedValueOnce({
      data: { id: 999, login: "test-user" },
    });

    // Add team member request mock
    mockRequest.mockResolvedValueOnce({
      data: {
        role: "member",
        state: "active",
      },
    });

    const membership = await client.addTeamMember(1, 999);
    expect(membership.githubLogin).toBe("test-user");
    expect(membership.role).toBe("member");
    expect(mockRequest).toHaveBeenCalledWith("GET /user/{account_id}", {
      account_id: 999,
    });
  });
});
