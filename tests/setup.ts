import path from "path";

// Setup default environment variables for all test files before they load config.ts
process.env.NODE_ENV = "test";
process.env.PORT = "3000";
process.env.PUBLIC_BASE_URL = "https://test.example.com";
process.env.APP_SECRET = "a".repeat(32);
process.env.DATABASE_PATH = path.resolve("./tests/test-db.sqlite");
process.env.SLACK_BOT_TOKEN = "xoxb-test";
process.env.SLACK_SIGNING_SECRET = "test";
process.env.SLACK_APPROVAL_CHANNEL_ID = "C111111";
process.env.SLACK_AUDIT_CHANNEL_ID = "C222222";
process.env.GITHUB_ORG = "test-org";
process.env.GITHUB_APP_ID = "12345";
process.env.GITHUB_CLIENT_ID = "Iv1.test";
process.env.GITHUB_CLIENT_SECRET = "test";
process.env.GITHUB_PRIVATE_KEY_BASE64 = Buffer.from(
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----",
).toString("base64");
process.env.GITHUB_WEBHOOK_SECRET = "test";
process.env.SETUP_TOKEN = "test-setup-token-at-least-32-chars-long";
