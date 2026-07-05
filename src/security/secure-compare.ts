import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison to prevent timing attacks on sensitive tokens.
 */
export function secureTokenEquals(
  actual: string,
  expected: string,
): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}
