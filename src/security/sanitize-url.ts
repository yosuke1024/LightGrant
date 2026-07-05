const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "setup_token",
  "code",
  "state",
  "access_token",
  "refresh_token",
]);

/**
 * Sanitizes URLs by replacing values of sensitive query parameters with [REDACTED].
 * Handles both absolute and relative URLs.
 */
export function sanitizeUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;
  try {
    const hasScheme = rawUrl.startsWith("http://") || rawUrl.startsWith("https://");
    const baseUrl = hasScheme ? undefined : "http://localhost";
    const url = new URL(rawUrl, baseUrl);
    
    let changed = false;
    for (const key of SENSITIVE_QUERY_KEYS) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, "[REDACTED]");
        changed = true;
      }
    }
    
    if (!changed) return rawUrl;
    
    return hasScheme ? url.toString() : url.pathname + url.search + url.hash;
  } catch {
    let sanitized = rawUrl;
    for (const key of SENSITIVE_QUERY_KEYS) {
      const regex = new RegExp(`([?&])${key}=([^&]*)`, "gi");
      sanitized = sanitized.replace(regex, `$1${key}=[REDACTED]`);
    }
    return sanitized;
  }
}
