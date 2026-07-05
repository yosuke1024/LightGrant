import crypto from "crypto";
import { config } from "../config.js";

export interface StatePayload {
  slackWorkspaceId: string;
  slackUserId: string;
  nonce: string;
  expiresAt: number;
}

function getAppSecret(): string {
  return config.APP_SECRET || process.env.APP_SECRET || "";
}

/**
 * Generate a cryptographically signed state token.
 */
export function generateStateToken(
  slackWorkspaceId: string,
  slackUserId: string,
  nonce: string,
  expiresAt: number,
): string {
  const payload: StatePayload = {
    slackWorkspaceId,
    slackUserId,
    nonce,
    expiresAt,
  };

  const payloadStr = JSON.stringify(payload);
  const payloadBase64 = Buffer.from(payloadStr).toString("base64url");

  const secret = getAppSecret();
  const signature = crypto
    .createHmac("sha256", secret)
    .update(payloadBase64)
    .digest("base64url");

  return `${payloadBase64}.${signature}`;
}

/**
 * Verify state token signature and expiration.
 * Returns the decoded payload details if valid, otherwise null.
 */
export function verifyStateToken(
  token: string,
): { slackWorkspaceId: string; slackUserId: string; nonce: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return null;
    }

    const [payloadBase64, signature] = parts;
    const secret = getAppSecret();

    // Verify signature using timing-safe comparison
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(payloadBase64)
      .digest("base64url");

    const expectedBuf = Buffer.from(expectedSignature, "utf8");
    const signatureBuf = Buffer.from(signature, "utf8");

    if (
      expectedBuf.length !== signatureBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, signatureBuf)
    ) {
      return null;
    }

    const payloadStr = Buffer.from(payloadBase64, "base64url").toString("utf8");
    const payload = JSON.parse(payloadStr) as StatePayload;

    // Check expiration
    if (Date.now() > payload.expiresAt) {
      return null;
    }

    return {
      slackWorkspaceId: payload.slackWorkspaceId,
      slackUserId: payload.slackUserId,
      nonce: payload.nonce,
    };
  } catch {
    return null;
  }
}
