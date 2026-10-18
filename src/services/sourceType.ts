/**
 * Source-type classification — pure functions, no app imports, so they can
 * be unit-tested with `node --test` and shared by resolvers and the player.
 *
 * Rules:
 *  - 'embed' is NEVER inferred from a URL. A provider must declare it, and
 *    even then it is only a claim that the page is meant to be framed.
 *  - 'hls' / 'mp4' are inferred from the URL pathname (query strings and
 *    fragments never count), or taken from an explicit declaration that is
 *    not contradicted by the URL.
 *  - Anything else is 'unknown': a webpage whose media type is not
 *    established. It must not be handed to ArtPlayer as if it were a file.
 */

export type SourceKind = 'embed' | 'hls' | 'mp4' | 'unknown';

export interface FrameEmbedPolicy {
  embeddable: boolean;
  reason?: string;
}

/**
 * Inspect response headers for policies that prevent a page from being framed.
 * This is a detection helper only; it does not bypass browser security policy.
 */
export function frameEmbedPolicy(headers: { get(name: string): string | null }): FrameEmbedPolicy {
  const xFrameOptions = headers.get('x-frame-options')?.trim().toLowerCase();
  if (xFrameOptions === 'deny') {
    return { embeddable: false, reason: 'X-Frame-Options: deny' };
  }
  if (xFrameOptions === 'sameorigin') {
    return { embeddable: false, reason: 'X-Frame-Options: sameorigin' };
  }
  if (xFrameOptions?.startsWith('allow-from ')) {
    return { embeddable: false, reason: `X-Frame-Options: ${xFrameOptions}` };
  }

  const csp = headers.get('content-security-policy');
  if (csp) {
    for (const policy of csp.split(',')) {
      const directive = policy
        .split(';')
        .map((part) => part.trim())
        .find((part) => /^frame-ancestors(?:\s|$)/i.test(part));
      if (!directive) continue;
      const sources = directive.replace(/^frame-ancestors\s*/i, '').trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (sources.length !== 1 || sources[0] !== '*') {
        return { embeddable: false, reason: `CSP frame-ancestors ${sources.join(' ') || '(no allowed ancestors)'}` };
      }
    }
  }

  return { embeddable: true };
}

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
 * Verdict on a probe response for a source of the given kind.
 *  true      -> evidence that media is really there
 *  false     -> evidence it is not (an HTML page, or a failed HLS proxy request)
 *  undefined -> inconclusive (leave the source unverified, don't bury it)
 *
 * MP4 playback uses the browser's direct <video> path, but probes use the
 * CORS proxy. A proxy-side 403/404/5xx therefore does not prove the direct
 * media URL is dead; only a successful response with an HTML/JSON/text body
 * can positively identify a non-video page.
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
  // MP4 is played directly, while the probe is sent through a proxy. An HTTP
  // failure from that proxy is inconclusive, unlike an HLS failure (which uses
  // the same proxy pipeline as playback).
  if (kind === 'mp4' && (status < 200 || status >= 300)) return undefined;
  if (status < 200 || status >= 300) return false;
  const ct = (contentType ?? '').toLowerCase();
  if (kind === 'hls') return typeof body === 'string' && body.includes('#EXTM3U');
  // mp4: an HTML/JSON/text body means a webpage or error page, not a video
  if (ct.startsWith('text/') || ct.includes('html') || ct.includes('json')) return false;
  return true;
}
