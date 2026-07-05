import { describe, it, expect } from "vitest";
import {
  validateBaseUrl,
  generateSlackManifest,
  generateGitHubManifest,
} from "../../src/services/manifest-service.js";

describe("ManifestService", () => {
  describe("validateBaseUrl", () => {
    it("should accept valid HTTPS URL and remove trailing slashes", () => {
      expect(validateBaseUrl("https://example.com")).toBe("https://example.com");
      expect(validateBaseUrl("https://example.com/")).toBe("https://example.com");
      expect(validateBaseUrl("https://example.com///")).toBe("https://example.com");
    });

    it("should reject HTTP URLs by default", () => {
      expect(() => validateBaseUrl("http://example.com")).toThrow("Base URL must use HTTPS protocol");
    });

    it("should accept HTTP URLs when allowHttp is true", () => {
      expect(validateBaseUrl("http://example.com", true)).toBe("http://example.com");
    });

    it("should reject URLs with credentials", () => {
      expect(() => validateBaseUrl("https://user:pass@example.com")).toThrow("Base URL must not contain credentials");
    });

    it("should reject URLs with query parameters", () => {
      expect(() => validateBaseUrl("https://example.com?query=1")).toThrow("Base URL must not contain query parameters");
    });

    it("should reject URLs with fragments", () => {
      expect(() => validateBaseUrl("https://example.com#hash")).toThrow("Base URL must not contain fragments");
    });

    it("should reject invalid URL format", () => {
      expect(() => validateBaseUrl("not-a-url")).toThrow("Invalid URL format");
    });
  });

  describe("generateSlackManifest", () => {
    it("should replace __PUBLIC_BASE_URL__ in slack-app.yaml.template", () => {
      const baseUrl = "https://my-slack-app.com";
      const manifest = generateSlackManifest(baseUrl);
      expect(manifest).toContain("url: https://my-slack-app.com/slack/events");
      expect(manifest).toContain("request_url: https://my-slack-app.com/slack/events");
      expect(manifest).not.toContain("__PUBLIC_BASE_URL__");
      expect(manifest).not.toContain("app_home_opened");
    });
  });

  describe("generateGitHubManifest", () => {
    it("should replace __PUBLIC_BASE_URL__ in github-app.json.template", () => {
      const baseUrl = "https://my-github-app.com";
      const manifest = generateGitHubManifest(baseUrl);
      expect(manifest.url).toBe("https://my-github-app.com");
      expect(manifest.callback_urls[0]).toBe("https://my-github-app.com/auth/github/callback");
      expect(manifest.hook_attributes.url).toBe("https://my-github-app.com/github/webhooks");
    });
  });
});
