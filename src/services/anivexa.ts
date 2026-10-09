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

function mapResult(env: WatchEnvelope, provider: string, audio: AudioType): AnivexaResult {
  const raw = (env.streams ?? env.sources ?? []).filter(
    // keep all stream types (embed/dash included for hanime/hstream)
    () => true,
  );
  const envReferer = env.referer ?? env.headers?.Referer ?? env.headers?.referer;

  const streams: StreamSource[] = [];
  const subtitles: SubtitleTrack[] = [];

  for (const s of raw) {
    const u = s.url;
    if (!u) continue;
    const referer = s.referer ?? s.headers?.Referer ?? s.headers?.referer ?? envReferer;
    streams.push({
      type: s.type === 'hls' || u.includes('.m3u8') ? 'hls' : 'mp4',
      url: u,
      server: `anivexa:${s.server ?? provider}`,
      audio,
      quality: s.quality,
      referer,
      viaProxy: !!referer,
    });
    // first stream with usable (vtt/srt) subtitles wins — ASS can't render in-app
    if (subtitles.length === 0) {
      for (const sub of s.subtitles ?? []) {
        if (!sub.url) continue;
        const fmt = (sub.format ?? sub.url.split('.').pop() ?? '').toLowerCase();
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