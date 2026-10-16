import { useSettingsStore } from '@/stores/settingsStore';
import type { AudioType, StreamSource, SubtitleTrack } from '@/types';
import { classifySourceKind } from './sourceType';

/** All 15 providers in Anivexa-API v2.2 (docs at GET /). */
export const ANIVEXA_PROVIDERS = [
  'mkissa',
  'reanime',
  'anikoto',
  'animegg',
  'anineko',
  'anidbapp',
  '2dhive',
  'animenosub',
  'anizone',
  'aniwaves',
  'anibd',
  'senshi',
  'kaa',
  'animedunya',
  'animeonsen',
] as const;

function base(): string {
  return useSettingsStore.getState().anivexaBaseUrl.replace(/\/$/, '');
}

function proxyBase(): string {
  return useSettingsStore.getState().proxyBaseUrl.replace(/\/$/, '');
}

function localSidecarUrl(url: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

async function responseError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  if (!body) return '';
  try {
    const parsed = JSON.parse(body) as { error?: string; message?: string };
    return parsed.error ?? parsed.message ?? body.slice(0, 240);
  } catch {
    return body.slice(0, 240);
  }
}

/** Fetch the local Anivexa sidecar directly; use the proxy only as a fallback
 * for non-local configured endpoints or when the direct request itself fails. */
async function get<T>(path: string): Promise<T> {
  const url = `${base()}${path}`;
  let direct: Response | undefined;

  try {
    direct = await fetch(url);
  } catch (e) {
    console.warn('[Anivexa] direct request failed for %s', path, e);
  }

  if (direct?.ok) {
    try {
      return (await direct.json()) as T;
    } catch (e) {
      console.warn('[Anivexa] invalid JSON from %s', path, e);
    }
  }

  // A 4xx/5xx from the local sidecar is the actual provider error. Proxying
  // localhost:4000 through localhost:8001 only repeats the same failure and
  // hides the useful response body, so preserve it for the resolver/UI.
  if (direct && !direct.ok && localSidecarUrl(url)) {
    const detail = await responseError(direct);
    throw new Error(
      `Anivexa HTTP ${direct.status} for ${path}${detail ? `: ${detail}` : ''}`,
    );
  }

  const proxiedUrl = `${proxyBase()}/cors?u=${encodeURIComponent(url)}`;
  const res = await fetch(proxiedUrl);
  if (!res.ok) {
    const detail = await responseError(res);
    throw new Error(
      `Anivexa proxy HTTP ${res.status} for ${path}${detail ? `: ${detail}` : ''}`,
    );
  }
  try {
    return (await res.json()) as T;
  } catch (e) {
    throw new Error(`Anivexa returned invalid JSON for ${path}: ${String(e)}`);
  }
}

interface RawSubtitle {
  url?: string;
  label?: string;
  srclang?: string;
  format?: string;
}

interface RawSource {
  url?: string;
  type?: string;
  server?: string;
  quality?: string;
  referer?: string;
  headers?: Record<string, string>;
  subtitles?: RawSubtitle[];
}

interface WatchEnvelope {
  streams?: RawSource[];
  sources?: RawSource[];
  headers?: Record<string, string>;
  referer?: string;
}

export interface AnivexaResult {
  streams: StreamSource[];
  subtitles: SubtitleTrack[];
}

function mapResult(env: WatchEnvelope, provider: string, audio: AudioType): AnivexaResult {
  const raw = env.streams ?? env.sources ?? [];
  const envReferer = env.referer ?? env.headers?.Referer ?? env.headers?.referer;

  const streams: StreamSource[] = [];
  const subtitles: SubtitleTrack[] = [];
  let droppedUnknown = 0;

  for (const s of raw) {
    const u = s.url?.trim();
    if (!u) continue;

    // Embed only when the provider declares it; hls/mp4 from the URL path.
    // An undeclared webpage is 'unknown' and is dropped here — it must never
    // be passed to ArtPlayer as if it were an MP4 file.
    const type = classifySourceKind(s.type, u);
    if (type === 'unknown') {
      droppedUnknown++;
      continue;
    }

    const referer = s.referer ?? s.headers?.Referer ?? s.headers?.referer ?? envReferer;
    // Keep subtitle tracks on the exact stream that supplied them. A provider
    // response can contain multiple streams with different subtitle tracks.
    const sourceSubtitles: SubtitleTrack[] = [];
    for (const sub of s.subtitles ?? []) {
      if (!sub.url) continue;
      let fmt = (sub.format ?? '').toLowerCase();
      if (!fmt) {
        try {
          fmt = new URL(sub.url).pathname.split('.').pop()?.toLowerCase() ?? '';
        } catch {
          fmt = '';
        }
      }
      if (fmt !== 'vtt' && fmt !== 'srt') continue;
      sourceSubtitles.push({ url: sub.url, lang: sub.label ?? sub.srclang ?? 'sub' });
    }

    streams.push({
      type,
      url: u,
      server: `anivexa:${s.server ?? provider}`,
      audio,
      quality: s.quality,
      referer,
      viaProxy: !!referer,
      subtitles: sourceSubtitles,
    });

    // Retain the first available set for callers that still use provider-level tracks.
    if (subtitles.length === 0) subtitles.push(...sourceSubtitles);
  }

  if (raw.length > 0 && streams.length === 0) {
    console.warn(
      `[Anivexa] ${provider}: received ${raw.length} source(s), but all were rejected as unsupported`,
      { declaredTypes: raw.map((s) => s.type ?? '(missing)').slice(0, 10), droppedUnknown },
    );
  } else if (droppedUnknown > 0) {
    console.warn(`[Anivexa] ${provider}: dropped ${droppedUnknown} unsupported source(s)`);
  }

  return { streams, subtitles };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('provider timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Anivexa-API: one AniList ID in, streams from every provider out. */
export const anivexa = {
  /** Query all providers in parallel; merge every success.
   *  Each provider gets 12s — slow/hung providers can't delay the chain. */
  async watchAll(
    anilistId: number | string,
    episode: number,
    audio: AudioType,
  ): Promise<AnivexaResult> {
    const results = await Promise.allSettled(
      ANIVEXA_PROVIDERS.map(async (provider) => {
        try {
          const env = await withTimeout(
            get<WatchEnvelope>(
              `/watch/${provider}/${anilistId}/${audio}/${provider}-${episode}`,
            ),
            12_000,
          );
          const result = mapResult(env, provider, audio);
          console.info(
            `[Anivexa] ${provider}: ${result.streams.length} playable stream(s)`,
          );
          return { provider, result };
        } catch (e) {
          console.warn(`[Anivexa] ${provider} failed:`, e instanceof Error ? e.message : String(e));
          throw e;
        }
      }),
    );

    const streams: StreamSource[] = [];
    const subtitles: SubtitleTrack[] = [];
    const failed: string[] = [];
    const empty: string[] = [];

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      const provider = ANIVEXA_PROVIDERS[i];
      if (r.status !== 'fulfilled') {
        failed.push(`${provider}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
        continue;
      }
      const { result } = r.value;
      if (result.streams.length === 0) empty.push(provider);
      streams.push(...result.streams);
      if (subtitles.length === 0) subtitles.push(...result.subtitles);
    }

    console.info(
      `[Anivexa] summary for AniList ${anilistId} ep ${episode}: ${streams.length} stream(s), ${failed.length} failed, ${empty.length} empty`,
    );

    if (streams.length === 0) {
      const details = [
        failed.length ? `failed: ${failed.slice(0, 6).join(' | ')}` : '',
        empty.length ? `no playable sources: ${empty.join(', ')}` : '',
      ].filter(Boolean).join('; ');
      throw new Error(
        `Anivexa: no playable streams from ${ANIVEXA_PROVIDERS.length} providers${details ? ` (${details})` : ''}`,
      );
    }

    return { streams, subtitles };
  },

  /** Query a single provider by name (e.g. 'hanime' for adult content). */
  async watch(
    provider: string,
    anilistId: number | string,
    episode: number,
    audio: AudioType,
  ): Promise<AnivexaResult> {
    const env = await withTimeout(
      get<WatchEnvelope>(
        `/watch/${provider}/${anilistId}/${audio}/${provider}-${episode}`,
      ),
      15_000,
    );
    return mapResult(env, provider, audio);
  },
};