/**
 * Minimal cookie parse/serialize helpers.
 *
 * Deliberately dependency-free: the browser-binding flow needs only to read one
 * cookie and to emit a hardened Set-Cookie, so pulling in cookie-parser would
 * add surface area for no benefit. Values are limited to the opaque hex tokens
 * this app sets, so no percent-encoding is required.
 */

export function parseCookies(
  header: string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const name = part.slice(0, eq).trim();
    if (!name) {
      continue;
    }
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

export interface CookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
  path?: string;
  sameSite?: "Strict" | "Lax" | "None";
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const {
    maxAgeSeconds,
    secure = true,
    path = "/",
    sameSite = "Lax",
  } = options;

  const segments = [
    `${name}=${value}`,
    `Path=${path}`,
    "HttpOnly",
    `SameSite=${sameSite}`,
  ];
  if (secure) {
    segments.push("Secure");
  }
  if (typeof maxAgeSeconds === "number") {
    segments.push(`Max-Age=${maxAgeSeconds}`);
  }
  return segments.join("; ");
}
