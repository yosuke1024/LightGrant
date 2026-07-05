import { describe, it, expect } from "vitest";
import pino from "pino";
import { Writable } from "stream";

describe("Logger Redaction", () => {
  const redactKeys = [
    "authorization",
    "token",
    "secret",
    "private_key",
    "client_secret",
    "cookie",
    "set-cookie",
    "*.authorization",
    "*.token",
    "*.secret",
    "*.private_key",
    "*.client_secret",
    "*.cookie",
    "*.set-cookie",
    "req.headers.authorization",
    "req.headers.cookie",
  ];

  it("should redact specified sensitive keys in flat and nested structures", () => {
    let loggedData = "";
    const stream = new Writable({
      write(chunk, encoding, callback) {
        loggedData += chunk.toString();
        callback();
      },
    });

    const testLogger = pino.default(
      {
        redact: {
          paths: redactKeys,
          censor: "[REDACTED]",
        },
      },
      stream,
    );

    testLogger.info({
      message: "Processing request",
      token: "xoxb-sensitive-slack-token",
      client_secret: "github-secret-key",
      regular_field: "safe-value",
      req: {
        headers: {
          authorization: "Bearer secret-jwt",
          cookie: "session=123",
        },
      },
    });

    const parsed = JSON.parse(loggedData.trim());

    expect(parsed.message).toBe("Processing request");
    expect(parsed.regular_field).toBe("safe-value");
    expect(parsed.token).toBe("[REDACTED]");
    expect(parsed.client_secret).toBe("[REDACTED]");
    expect(parsed.req.headers.authorization).toBe("[REDACTED]");
    expect(parsed.req.headers.cookie).toBe("[REDACTED]");
  });
});
