import { describe, it, expect, beforeAll } from "vitest";
import {
  generateStateToken,
  verifyStateToken,
} from "../../src/security/signed-state.js";

describe("Signed State Security Module", () => {
  beforeAll(() => {
    process.env.APP_SECRET = "a".repeat(32); // Ensure APP_SECRET is set
  });

  it("should generate a signed token and verify it correctly", () => {
    const expiresAt = Date.now() + 600000; // 10 mins from now
    const token = generateStateToken("W123", "U456", "random-nonce", expiresAt);

    expect(token).toBeDefined();
    expect(typeof token).toBe("string");

    const verified = verifyStateToken(token);
    expect(verified).not.toBeNull();
    expect(verified?.slackWorkspaceId).toBe("W123");
    expect(verified?.slackUserId).toBe("U456");
    expect(verified?.nonce).toBe("random-nonce");
  });

  it("should fail verification if token is tampered with", () => {
    const expiresAt = Date.now() + 600000;
    const token = generateStateToken("W123", "U456", "random-nonce", expiresAt);

    // Tamper with token (alter one character in payload or signature part)
    const tampered = token.slice(0, -5) + "xxxxx";
    const verified = verifyStateToken(tampered);
    expect(verified).toBeNull();
  });

  it("should fail verification if token is expired", () => {
    const expiresAt = Date.now() - 1000; // expired 1s ago
    const token = generateStateToken("W123", "U456", "random-nonce", expiresAt);

    const verified = verifyStateToken(token);
    expect(verified).toBeNull();
  });
});
