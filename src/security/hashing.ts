import crypto from "crypto";

/**
 * Deterministically serialize an object to JSON by sorting its keys.
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) {
    return "";
  }
  const allKeys: string[] = [];
  JSON.stringify(obj, (key, value) => {
    if (key) allKeys.push(key);
    return value;
  });
  allKeys.sort();
  return JSON.stringify(obj, allKeys);
}

/**
 * Generate a SHA-256 hash of a string.
 */
export function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
