import { describe, it, expect } from "vitest";
import { sanitizeUrl } from "../../src/security/sanitize-url.js";

describe("sanitizeUrl", () => {
  it("should redact sensitive query parameters in relative URLs", () => {
    expect(sanitizeUrl("/setup?setup_token=super-secret")).toBe("/setup?setup_token=%5BREDACTED%5D");
    expect(sanitizeUrl("/setup/download?token=mytoken123")).toBe("/setup/download?token=%5BREDACTED%5D");
    expect(sanitizeUrl("/auth/github/callback?code=oauthcode&state=oauthstate")).toBe("/auth/github/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D");
  });

  it("should redact sensitive query parameters in absolute URLs", () => {
    expect(sanitizeUrl("http://localhost:3000/setup?setup_token=secret")).toBe("http://localhost:3000/setup?setup_token=%5BREDACTED%5D");
  });

  it("should preserve non-sensitive query parameters", () => {
    expect(sanitizeUrl("/search?q=test&token=secret")).toBe("/search?q=test&token=%5BREDACTED%5D");
  });

  it("should handle URLs without query parameters", () => {
    expect(sanitizeUrl("/health")).toBe("/health");
    expect(sanitizeUrl("")).toBe("");
  });
});
