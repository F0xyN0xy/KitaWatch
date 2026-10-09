import { useSettingsStore } from '@/stores/settingsStore';
import type { AudioType, StreamSource, SubtitleTrack } from '@/types';

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

/** Fetch with a CORS-proxy fallback (self-hosted instances vary on headers). */
async function get<T>(path: string): Promise<T> {
  const url = `${base()}${path}`;
  try {
    const res = await fetch(url);
    if (res.ok) return (await res.json()) as T;
  } catch {
    // fall through to proxied attempt
  }
  const res = await fetch(`${proxyBase()}/cors?u=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(`Anivexa responded ${res.status} for ${path}`);
  return (await res.json()) as T;
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

/**
 * Infer only formats the in-app player can actually consume. A provider page
 * returning HTTP 200 is not a video stream, so unknown URLs must not silently
 * be mislabeled as MP4. Providers may explicitly mark a URL as an embed; the
 * player must separately decide whether that embed is supported/allowed.
 */
function classifySource(s: RawSource): 'hls' | 'mp4' | 'embed' | null {
  const declared = s.type?.trim().toLowerCase();
  if (declared === 'embed') return 'embed';
  if (declared === 'hls') return 'hls';
  if (declared === 'mp4') return 'mp4';

  if (!s.url) return null;
  try {
    const pathname = new URL(s.url).pathname.toLowerCase();
    if (pathname.endsWith('.m3u8')) return 'hls';
    if (pathname.endsWith('.mp4') || pathname.endsWith('.m4v')) return 'mp4';
  } catch {
    // Invalid or relative URLs are not safely classifiable here.
  }
  return null;
}

function mapResult(env: WatchEnvelope, provider: string, audio: AudioType): AnivexaResult {
  const raw = env.streams ?? env.sources ?? [];
  const envReferer = env.referer ?? env.headers?.Referer ?? env.headers?.referer;

  const streams: StreamSource[] = [];
  const subtitles: SubtitleTrack[] = [];

  for (const s of raw) {
    const u = s.url?.trim();
    if (!u) continue;

    const type = classifySource({ ...s, url: u });
    // Don't tell ArtPlayer that an ordinary HTML page is an MP4 file.
    if (!type) continue;

    const referer = s.referer ?? s.headers?.Referer ?? s.headers?.referer ?? envReferer;
    streams.push({
      type,
      url: u,
      server: `anivexa:${s.server ?? provider}`,
      audio,
      quality: s.quality,
      referer,
      viaProxy: !!referer,
    });

    // First stream with usable (VTT/SRT) subtitles wins — ASS isn't rendered in-app.
    if (subtitles.length === 0) {
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
        subtitles.push({ url: sub.url, lang: sub.label ?? sub.srclang ?? 'sub' });
      }
    }
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
        const env = await withTimeout(
          get<WatchEnvelope>(
            `/watch/${provider}/${anilistId}/${audio}/${provider}-${episode}`,
          ),
          12_000,
        );
        return mapResult(env, provider, audio);
      }),
    );

    const streams: StreamSource[] = [];
    const subtitles: SubtitleTrack[] = [];
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      streams.push(...r.value.streams);
      if (subtitles.length === 0) subtitles.push(...r.value.subtitles);
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