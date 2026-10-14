import { useSettingsStore } from '@/stores/settingsStore';
import type { AudioType, StreamSource, SubtitleTrack } from '@/types';

/**
 * 1anime.app aggregator API (captured from their frontend):
 *   GET /api/stream?anilistId=<id>&providerName=<p>&episodeNumber=<n>&subOrDub=<s|d>
 * Providers observed: ZenV2, Zen (softsub); Pahe, Zone, Senshi, Anitaku,
 * AnimeVerse, AnimeHeaven (hardsub, mostly erroring upstream).
 * We race the candidates and merge every success.
 */
const BASE = 'https://1anime.app';
const PROVIDER_CANDIDATES = ['ZenV2', 'Zen', 'Pahe', 'Anitaku', 'AnimeHeaven', 'AnimeVerse', 'Senshi', 'Zone'];

function proxyBase(): string {
  return useSettingsStore.getState().proxyBaseUrl.replace(/\/$/, '');
}

async function get<T>(path: string): Promise<T> {
  const url = `${BASE}${path}`;
  let lastError = 'Request failed';

  try {
    const res = await fetch(url);

    if (res.ok) return (await res.json()) as T;

    lastError = `Direct request returned HTTP ${res.status}`;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  }

  try {
    const res = await fetch(
      `${proxyBase()}/cors?u=${encodeURIComponent(url)}`,
    );

    if (!res.ok) {
      const body = (await res.text()).slice(0, 500);
      throw new Error(
        `Proxy returned HTTP ${res.status}: ${body || 'empty response'}`,
      );
    }

    return (await res.json()) as T;
  } catch (error) {
    const proxyError =
      error instanceof Error ? error.message : String(error);

    throw new Error(
      `1anime request failed. Direct: ${lastError}. Proxy: ${proxyError}`,
    );
  }
}

interface RawStream {
  url?: string;
  link?: string;
  file?: string;
  isM3U8?: boolean;
  type?: string;
  quality?: string;
  server?: string;
  headers?: Record<string, string>;
}

interface StreamEnvelope {
  sources?: RawStream[];
  streams?: RawStream[];
  links?: RawStream[];
  subtitles?: { url?: string; file?: string; label?: string; lang?: string }[];
  intro?: { start?: number; end?: number };
  outro?: { start?: number; end?: number };
}

export interface OneAnimeStreams {
  streams: StreamSource[];
  subtitles: SubtitleTrack[];
}

function mapEnvelope(env: StreamEnvelope, provider: string, audio: AudioType): OneAnimeStreams {
  const raw = env.sources ?? env.streams ?? env.links ?? [];
  const streams: StreamSource[] = [];
  for (const s of raw) {
    const u = s.url ?? s.link ?? s.file;
    if (!u) continue;
    const referer = s.headers?.Referer ?? s.headers?.referer;
    streams.push({
      type: s.isM3U8 || u.includes('.m3u8') || s.type === 'hls' ? 'hls' : 'mp4',
      url: u,
      server: `1anime:${s.server ?? provider}`,
      audio,
      quality: s.quality,
      referer,
      viaProxy: !!referer,
    });
  }
  const subtitles: SubtitleTrack[] = [];
  for (const sub of env.subtitles ?? []) {
    const u = sub.url ?? sub.file;
    if (!u) continue;
    subtitles.push({ url: u, lang: sub.label ?? sub.lang ?? 'sub' });
  }
  return { streams, subtitles };
}

export const oneanime = {
  /** Resolve streams for an AniList ID + episode, racing all provider candidates. */
  async streams(anilistId: number | string, episode: number, audio: AudioType): Promise<OneAnimeStreams> {
    const subOrDub = audio === 'dub' ? 'd' : 's';
    const pathFor = (provider: string) =>
      `/api/stream?anilistId=${encodeURIComponent(String(anilistId))}&providerName=${encodeURIComponent(provider)}&episodeNumber=${episode}&subOrDub=${subOrDub}`;

    const results = await Promise.allSettled(
      PROVIDER_CANDIDATES.map(async (provider) =>
        mapEnvelope(await get<StreamEnvelope>(pathFor(provider)), provider, audio),
      ),
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
};
