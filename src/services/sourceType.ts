/**
 * Source-type classification — pure functions, no app imports, so they can
 * be unit-tested with `node --test` and shared by resolvers and the player.
 *
 * Rules:
 *  - 'embed' is NEVER inferred from a URL. A provider must declare it, and
 *    even then it is only a claim that the page is meant to be framed.
 *  - 'hls' / 'mp4' are inferred from the URL *pathname* (query strings and
 *    fragments never count), or taken from an explicit declaration that is
 *    not contradicted by the URL.
 *  - Anything else is 'unknown': a webpage whose media type is not
 *    established. It must not be handed to ArtPlayer as if it were a file.
 */

export type SourceKind = 'embed' | 'hls' | 'mp4' | 'unknown';

const MP4_EXT = ['.mp4', '.m4v'];
/** Path endings that identify an ordinary webpage, never a media file. */
const PAGE_EXT = ['.html', '.htm', '.php', '.asp', '.aspx', '.jsp'];

/** Parse an absolute http(s) URL; null for relative, malformed or other schemes. */
export function parseHttpUrl(raw: string | undefined | null): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Media kind implied by the URL path alone ('embed' is never inferred). */
export function kindFromUrl(raw: string | undefined | null): 'hls' | 'mp4' | 'unknown' {
  const u = parseHttpUrl(raw);
  if (!u) return 'unknown';
  const path = u.pathname.toLowerCase();
  if (path.endsWith('.m3u8')) return 'hls';
  if (MP4_EXT.some((e) => path.endsWith(e))) return 'mp4';
  return 'unknown';
}

/**
 * Final kind for a provider-supplied source.
 *  - declared 'embed'  -> 'embed' (valid http(s) URL required, and the URL
 *    must not itself be a media file — that would be a mislabel).
 *  - declared 'hls'/'mp4' -> trusted only if the URL path does not point at a
 *    different media kind; a declared media type on a plain webpage URL with
 *    no media extension is accepted only for hls/mp4 declarations that carry
 *    no extension at all (token URLs like /stream/abc?sig=…), never for pages.
 *  - undeclared -> URL inference, else 'unknown'.
 */
export function classifySourceKind(
  declaredType: string | undefined | null,
  url: string | undefined | null,
): SourceKind {
  const parsed = parseHttpUrl(url);
  if (!parsed) return 'unknown';
  const declared = declaredType?.trim().toLowerCase();
  const inferred = kindFromUrl(url);
  // A URL that is plainly a webpage can't be a declared media file.
  if ((declared === 'hls' || declared === 'mp4') && inferred === 'unknown') {
    const path = parsed.pathname.toLowerCase();
    if (PAGE_EXT.some((e) => path.endsWith(e))) return 'unknown';
  }

  if (declared === 'embed') return inferred === 'unknown' ? 'embed' : inferred;
  if (declared === 'hls' || declared === 'mp4') {
    if (inferred !== 'unknown' && inferred !== declared) return inferred;
    return declared;
  }
  return inferred;
}

/** True for kinds ArtPlayer can play directly. */
export const isDirectMedia = (k: SourceKind): k is 'hls' | 'mp4' => k === 'hls' || k === 'mp4';

/** Subtitle format from a URL pathname (query-safe); defaults to 'vtt'. */
export function subtitleFormat(raw: string): 'ass' | 'srt' | 'vtt' {
  const u = parseHttpUrl(raw);
  const path = (u ? u.pathname : raw.split(/[?#]/)[0]).toLowerCase();
  if (path.endsWith('.ass') || path.endsWith('.ssa')) return 'ass';
  if (path.endsWith('.srt')) return 'srt';
  return 'vtt';
}

/**
 * Can this response be framed by another origin? Derived ONLY from the
 * response headers the provider itself sent. This is detection, not a
 * workaround: a page that forbids framing is reported unsupported.
 *
 * Limits (cannot be fixed client-side): JS frame-busting, cookie/sandbox
 * behaviour and per-embedder allow-lists are invisible here, and the browser
 * fires `load` on the iframe even when it blocked the page.
 */
export function frameEmbedPolicy(
  headers: { get(name: string): string | null },
): { embeddable: boolean; reason?: string } {
  const xfo = headers.get('x-frame-options')?.trim().toLowerCase();
  if (xfo) {
    // DENY / SAMEORIGIN block every cross-origin embedder (the app is never
    // same-origin with a provider); ALLOW-FROM is obsolete and ignored by
    // current browsers, so it cannot be relied on.
    return { embeddable: false, reason: `X-Frame-Options: ${xfo}` };
  }
  const csp = headers.get('content-security-policy');
  if (csp) {
    const directive = csp
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.toLowerCase().startsWith('frame-ancestors'));
    if (directive) {
      const sources = directive.split(/\s+/).slice(1).map((s) => s.toLowerCase());
      const open = sources.some((s) => s === '*' || s === 'https:' || s === 'tauri:');
      if (!open) return { embeddable: false, reason: `CSP ${directive}` };
    }
  }
  return { embeddable: true };
}

/**
 * Verdict on a probe response for a source of the given kind.
 *  true      -> evidence that media is really there
 *  false     -> evidence it is not (error status, an HTML page, no manifest)
 *  undefined -> inconclusive (leave the source unverified, don't bury it)
 *
 * HTTP 200 alone is never proof: a webpage returns 200 too.
 */
export function mediaResponseVerdict(
  kind: SourceKind,
  status: number,
  contentType: string | null,
  body?: string,
): boolean | undefined {
  if (kind === 'embed') return undefined; // a frame's status says nothing about playback
  if (kind === 'unknown') return false;
  if (status === 405 || status === 501) return undefined;
  if (status < 200 || status >= 300) return false;
  const ct = (contentType ?? '').toLowerCase();
  if (kind === 'hls') return typeof body === 'string' && body.includes('#EXTM3U');
  // mp4: an HTML/JSON/text body means a webpage or error page, not video
  if (ct.startsWith('text/') || ct.includes('html') || ct.includes('json')) return false;
  return true;
}
