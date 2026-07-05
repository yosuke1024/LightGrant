import pino from "pino";
import { config } from "./config.js";

// Define the keys to redact in the logs for security
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
  "req.query.token",
  "req.query.setup_token",
  "req.query.code",
  "req.query.state",
];

const maskSensitiveString = (str: string): string => {
  if (!str) return str;
  return str
    .replace(/xoxb-[a-zA-Z0-9-]+/g, "[REDACTED_SLACK_TOKEN]")
    .replace(/ghs_[a-zA-Z0-9]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/ghp_[a-zA-Z0-9]+/g, "[REDACTED_GITHUB_TOKEN]");
};

const maskObject = (obj: unknown): unknown => {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") {
    return maskSensitiveString(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(maskObject);
  }
  if (typeof obj === "object") {
    const masked: Record<string, unknown> = {};
    const record = obj as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      masked[key] = maskObject(record[key]);
    }
    return masked;
  }
  return obj;
};

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: redactKeys,
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label: string) => {
      return { level: label };
    },
  },
  serializers: {
    err: (err: unknown) => {
      const serialized = pino.stdSerializers.err(err as Error);
      if (serialized) {
        if (serialized.message)
          serialized.message = maskSensitiveString(serialized.message);
        if (serialized.stack)
          serialized.stack = maskSensitiveString(serialized.stack);
      }
      return serialized;
    },
  },
  hooks: {
    logMethod(inputArgs, method) {
      const maskedArgs = inputArgs.map((arg) => maskObject(arg));
      return method.apply(this, maskedArgs as [unknown, string | undefined, ...unknown[]]);
    },
  },
});

// Helper to create a logger child with correlation context
export interface LogContext {
  correlationId?: string;
  requestId?: string;
  accessRequestId?: string;
  grantId?: string;
  jobId?: string;
  githubRequestId?: string;
  slackInteractionType?: string;
}

export function childLogger(context: LogContext) {
  return logger.child(context);
}
