// Source-type helpers for sidecar providers. Mirrors the pure logic of
// src/services/sourceType.ts (the app and the packaged sidecar are separate
// bundles, so the small helpers are duplicated rather than shared).

/** Resolve `raw` against `base`; only absolute http(s) URLs are returned. */
export function absoluteHttpUrl(raw, base) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim().replace(/\\\//g, "/"), base);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** "hls" | "mp4" from the URL *pathname* (query strings never count), else null. */
export function mediaKindFromUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith(".m3u8")) return "hls";
    if (path.endsWith(".mp4") || path.endsWith(".m4v")) return "mp4";
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * Can a response be framed by another origin, judging ONLY by the headers the
 * provider sent? Detection, not a workaround: a page that forbids framing is
 * reported as unsupported. Cannot see JS frame-busting.
 */
export function frameEmbedPolicy(headers) {
  const xfo = headers.get("x-frame-options")?.trim().toLowerCase();
  if (xfo) return { embeddable: false, reason: `X-Frame-Options: ${xfo}` };
  const csp = headers.get("content-security-policy");
  if (csp) {
    const directive = csp
      .split(";")
      .map((d) => d.trim())
      .find((d) => d.toLowerCase().startsWith("frame-ancestors"));
    if (directive) {
      const sources = directive.split(/\s+/).slice(1).map((s) => s.toLowerCase());
      const open = sources.some((s) => s === "*" || s === "https:" || s === "tauri:");
      if (!open) return { embeddable: false, reason: `CSP ${directive}` };
    }
  }
  return { embeddable: true };
}
