import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";
import path from "path";

describe("Config Validation", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const validPrivatePemBase64 = Buffer.from(
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
  ).toString("base64");

  const setValidEnv = () => {
    process.env.NODE_ENV = "test";
    process.env.PORT = "3000";
    process.env.PUBLIC_BASE_URL = "https://test.example.com";
    process.env.APP_SECRET = "a".repeat(32); // 32 chars
    process.env.DATABASE_PATH = path.resolve("/tmp/test-db.sqlite");
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    process.env.SLACK_SIGNING_SECRET = "slack-secret";
    process.env.SLACK_APPROVAL_CHANNEL_ID = "C1111111";
    process.env.SLACK_AUDIT_CHANNEL_ID = "C2222222";
    process.env.GITHUB_ORG = "test-org";
    process.env.GITHUB_APP_ID = "12345";
    process.env.GITHUB_CLIENT_ID = "Iv1.test-client-id";
    process.env.GITHUB_CLIENT_SECRET = "github-client-secret";
    process.env.GITHUB_PRIVATE_KEY_BASE64 = validPrivatePemBase64;
    process.env.GITHUB_WEBHOOK_SECRET = "github-webhook-secret";
    process.env.SETUP_TOKEN = "test-setup-token-at-least-32-chars-long";
  };

  it("should validate and load correct configuration", () => {
    setValidEnv();
    const config = loadConfig();
    expect(config.NODE_ENV).toBe("test");
    expect(config.PORT).toBe(3000);
    expect(config.PUBLIC_BASE_URL).toBe("https://test.example.com"); // normalized without trailing slash
    expect(config.DATABASE_PATH).toBe(path.resolve("/tmp/test-db.sqlite"));
  });

  it("should reject trailing slash in PUBLIC_BASE_URL", () => {
    setValidEnv();
    process.env.PUBLIC_BASE_URL = "https://test.example.com/";
    const config = loadConfig();
    expect(config.PUBLIC_BASE_URL).toBe("https://test.example.com");
  });

  it("should fail validation when GITHUB_PRIVATE_KEY_BASE64 is not valid base64 PEM key", () => {
    setValidEnv();
    process.env.GITHUB_PRIVATE_KEY_BASE64 =
      Buffer.from("invalid-key").toString("base64");
    expect(() => loadConfig()).toThrow("Configuration validation failed");
  });

  it("should fail validation if DATABASE_PATH is not absolute", () => {
    setValidEnv();
    process.env.DATABASE_PATH = "relative/path/to/db.sqlite";
    expect(() => loadConfig()).toThrow("Configuration validation failed");
  });

  it("should fail validation if any placeholder is present", () => {
    setValidEnv();
    process.env.SLACK_BOT_TOKEN = "xoxb-your-slack-bot-token"; // contains placeholder
    expect(() => loadConfig()).toThrow("Configuration validation failed");
  });

  it("should fail validation if APP_SECRET is less than 32 characters", () => {
    setValidEnv();
    process.env.APP_SECRET = "short";
    expect(() => loadConfig()).toThrow("Configuration validation failed");
  });

  it("should fail validation if SETUP_TOKEN is less than 32 characters", () => {
    setValidEnv();
    process.env.SETUP_TOKEN = "too-short";
    expect(() => loadConfig()).toThrow("Configuration validation failed");
  });
});
