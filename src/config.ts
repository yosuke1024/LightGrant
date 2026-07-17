import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Load environment variables from .env during development
if (process.env.NODE_ENV !== "production") {
  dotenv.config();
}

// Common placeholders to reject
const PLACEHOLDERS = [
  "your-slack-bot-token",
  "your-slack-signing-secret",
  "your-slack-client-id",
  "your-slack-client-secret",
  "C0000000000",
  "my-organization",
  "your-client-id",
  "your-github-client-secret",
  "your-base64-encoded-private-key",
  "your-github-webhook-secret",
  "at-least-32-random-bytes-change-this-in-production",
];

const isNotPlaceholder = (val: string) => {
  return !PLACEHOLDERS.some((placeholder) => val.includes(placeholder));
};

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("production"),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .refine(isNotPlaceholder, {
      message: "Must not contain placeholder values",
    })
    .transform((url) => (url.endsWith("/") ? url.slice(0, -1) : url)),
  APP_SECRET: z
    .string()
    .min(32, { message: "APP_SECRET must be at least 32 characters long" })
    .refine(isNotPlaceholder, {
      message: "Must not contain placeholder values",
    }),
  DATABASE_PATH: z
    .string()
    .refine((val) => path.isAbsolute(val), {
      message: "DATABASE_PATH must be an absolute path",
    })
    .refine(isNotPlaceholder, {
      message: "Must not contain placeholder values",
    }),
  SLACK_BOT_TOKEN: z.string().startsWith("xoxb-").refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  SLACK_SIGNING_SECRET: z.string().min(1).refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  // Slack app credentials used for "Sign in with Slack" (OpenID Connect).
  // Required so the GitHub OAuth flow can prove the browser completing the
  // link belongs to the Slack user recorded in the signed state.
  SLACK_CLIENT_ID: z.string().min(1).refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  SLACK_CLIENT_SECRET: z.string().min(1).refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  SLACK_APPROVAL_CHANNEL_ID: z.string().min(1).refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  SLACK_AUDIT_CHANNEL_ID: z.string().min(1).refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  GITHUB_ORG: z.string().min(1).refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  GITHUB_APP_ID: z.coerce
    .number()
    .int()
    .positive()
    .refine((val) => val !== 123456, {
      message: "Must not use placeholder GITHUB_APP_ID (123456)",
    }),
  GITHUB_CLIENT_ID: z.string().min(1).refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  GITHUB_CLIENT_SECRET: z.string().min(1).refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  GITHUB_PRIVATE_KEY_BASE64: z
    .string()
    .refine(isNotPlaceholder, {
      message: "Must not contain placeholder values",
    })
    .refine(
      (val) => {
        try {
          const decoded = Buffer.from(val, "base64").toString("utf8");
          return (
            decoded.includes("BEGIN RSA PRIVATE KEY") ||
            decoded.includes("BEGIN PRIVATE KEY")
          );
        } catch {
          return false;
        }
      },
      { message: "Must be a valid base64 encoded PEM private key" },
    )
    .transform((val) => Buffer.from(val, "base64").toString("utf8")),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).refine(isNotPlaceholder, {
    message: "Must not contain placeholder values",
  }),
  DISPLAY_TIMEZONE: z.string().default("UTC"),
  DEFAULT_DURATION_MINUTES: z.coerce.number().int().positive().default(60),
  MAX_REQUEST_DURATION_MINUTES: z.coerce.number().int().positive().default(480),
  ALLOWED_DURATIONS_MINUTES: z
    .string()
    .default("30,60,120,240,480")
    .transform((val) => val.split(",").map((s) => parseInt(s.trim(), 10)))
    .refine((arr) => arr.every((n) => !isNaN(n) && n > 0), {
      message: "All durations must be valid positive integers",
    }),
  REVOCATION_POLL_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30),
  JOB_POLL_INTERVAL_SECONDS: z.coerce.number().int().positive().default(2),
  TEAM_CACHE_REFRESH_SECONDS: z.coerce.number().int().positive().default(600),
  POLICY_AUTHORITY_REFRESH_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(3600),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
  EXPORT_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  JOB_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  ADMIN_SLACK_USER_IDS: z
    .string()
    .default("")
    .transform((val) =>
      val.trim() === "" ? [] : val.split(",").map((s) => s.trim()),
    ),
  SETUP_TOKEN: z
    .string()
    .min(32, {
      message: "SETUP_TOKEN must be at least 32 characters long",
    })
    .refine(isNotPlaceholder, {
      message: "Must not contain placeholder values",
    }),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error("Configuration validation failed:");
    console.error(JSON.stringify(result.error.format(), null, 2));
    throw new Error("Configuration validation failed. Exiting.");
  }
  return result.data;
}

export const config = loadConfig();
