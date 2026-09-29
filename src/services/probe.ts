import { proxy } from './api';
import type { StreamSource } from '@/types';

/** Pre-play stream validation.
 *
 * Providers happily return stream URLs that 403/500 when the player actually
 * hits them. Probing marks each URL as playable or dead so the source list
 * can bury dead ones instead of letting the user click through them.
 *
 * Path per type matches playback exactly:
 * - HLS is always routed through the local proxy (referer-locked hosts), so
 *   probe through proxy.m3u8 — a failure there is a guaranteed playback
 *   failure.
 * - MP4 plays directly in <video> (no CORS needed for playback), so a probe
 *   failure via the proxy is inconclusive — the stream stays "unknown"
 *   rather than "dead".
 */

const CACHE_TTL_MS = 5 * 60_000;
// 8s — 4s produced false "dead" verdicts on busy proxy/hosts that play fine,
// which made live sources disappear from the list when late providers merged.
const TIMEOUT_MS = 8000;
const CONCURRENCY = 4;

const cache = new Map<string, { at: number; ok: boolean | undefined }>();
const inflight = new Map<string, Promise<boolean | undefined>>();

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function probeOne(s: StreamSource): Promise<boolean | undefined> {
  const isHls = s.type === 'hls' || s.url.includes('.m3u8');
  try {
    if (isHls) {
      // Same pipeline the player uses; response is the (rewritten) manifest.
      const res = await fetchWithTimeout(proxy.m3u8(s.url, s.referer ?? ''));
      if (!res.ok) return false;
      const text = await res.text();
      return text.includes('#EXTM3U');
    }
    // MP4: HEAD keeps it cheap (no body). 405/501 = "unknown", not dead —
    // the direct <video> path may still work even if the proxy can't tell.
    const res = await fetchWithTimeout(proxy.cors(s.url), { method: 'HEAD' });
    if (res.ok) return true;
    return res.status === 405 || res.status === 501 ? undefined : false;
  } catch {
    return isHls ? false : undefined;
  }
}

/** Probe one stream; cached per URL for a few minutes. undefined = unknown. */
export function probeStream(s: StreamSource): Promise<boolean | undefined> {
  const hit = cache.get(s.url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return Promise.resolve(hit.ok);

  let p = inflight.get(s.url);
  if (!p) {
    p = probeOne(s).then((ok) => {
      cache.set(s.url, { at: Date.now(), ok });
      inflight.delete(s.url);
      return ok;
    });
    inflight.set(s.url, p);
  }
  return p;
}

/** Probe a batch with a small concurrency pool. Resolves to url -> result. */
export async function probeAll(streams: StreamSource[]): Promise<Map<string, boolean | undefined>> {
  const out = new Map<string, boolean | undefined>();
  const queue = [...streams];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    let s: StreamSource | undefined;
    while ((s = queue.shift())) {
      out.set(s.url, await probeStream(s));
    }
  });
  await Promise.all(workers);
  return out;
}
