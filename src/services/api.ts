import { useSettingsStore } from '@/stores/settingsStore';
import type {
  AnimeInfo,
  AnimeSummary,
  AudioType,
  EpisodeSummary,
  ExtractResponse,
  FilterSort,
  Paged,
  ProviderStatus,
  SpotlightAnime,
} from '@/types';

/** The app always talks to its own bundled sidecars. */
const API_BASE_URL = 'http://127.0.0.1:8000';

const DEFAULT_TIMEOUT_MS = 12_000;

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const base = API_BASE_URL;
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    if (!res.ok) {
      throw new ApiError(`Request failed with status ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError('Request timed out. Is the API running?');
    }
    throw new ApiError(err instanceof Error ? err.message : 'Network error');
  } finally {
    clearTimeout(timer);
  }
}

// ── Normalization ────────────────────────────────────────────
// The API is experimental and field shapes drift (AniList titles are
// objects, scores can be strings, covers can be nested). Every list item
// passes through normalizeAnime so the UI only ever sees clean data.

type Raw = Record<string, unknown>;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function titleOf(v: unknown): string {
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object') {
    const t = v as Raw;
    return str(t.english) ?? str(t.romaji) ?? str(t.native) ?? 'Unknown title';
  }
  return 'Unknown title';
}

function imageOf(v: unknown): string | undefined {
  if (typeof v === 'string') return v || undefined;
  if (v && typeof v === 'object') {
    const o = v as Raw;
    return str(o.large) ?? str(o.medium) ?? str(o.extraLarge);
  }
  return undefined;
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v)
    ? v.filter((g): g is string => typeof g === 'string')
    : undefined;
}

export function normalizeAnime(raw: unknown): AnimeSummary {
  const r = (raw ?? {}) as Raw;
  return {
    id: num(r.id) ?? num(r.anilistId) ?? 0,
    title: titleOf(r.title),
    cover: str(r.cover) ?? imageOf(r.coverImage) ?? imageOf(r.poster),
    banner: str(r.banner) ?? imageOf(r.bannerImage),
    rating: num(r.rating) ?? num(r.meanScore) ?? num(r.score),
    type: str(r.type) ?? str(r.format),
    subCount: num(r.subCount) ?? num(r.subEpisodes),
    dubCount: num(r.dubCount) ?? num(r.dubEpisodes),
    totalEpisodes: num(r.totalEpisodes) ?? num(r.episodes),
    genres: strArray(r.genres),
    season: str(r.season),
    year: num(r.year) ?? num(r.seasonYear),
    status: str(r.status),
    isAdult:
      r.isAdult === true ||
      (Array.isArray(r.genres) &&
        r.genres.some(
          (g) => typeof g === 'string' && g.toLowerCase() === 'hentai',
        )),
  };
}

/** v3 returns { results, hasNextPage, ... }; tolerate bare arrays (older forks). */
async function paged<T>(path: string, params?: Record<string, string | number | boolean | undefined>): Promise<Paged<T>> {
  const raw = await request<Paged<T> | T[]>(path, params);
  if (Array.isArray(raw)) {
    return { page: 1, perPage: raw.length, total: raw.length, hasNextPage: false, results: raw };
  }
  return { ...raw, results: Array.isArray(raw?.results) ? raw.results : [] };
}

async function pagedAnime(
  path: string,
  params?: Record<string, string | number | boolean | undefined>,
): Promise<Paged<AnimeSummary>> {
  const p = await paged<unknown>(path, params);
  return { ...p, results: p.results.map(normalizeAnime) };
}

// ── Episodes adapter ─────────────────────────────────────────
// v3 shape: { providers: { anineko: { episodes: { sub: [...], dub: [...] } }, ... } }
// Tolerates a flat array from older instances.

interface RawEpisode {
  number?: number;
  title?: string;
  thumbnail?: string;
}

interface EpisodesEnvelope {
  providers?: Record<
    string,
    { episodes?: { sub?: RawEpisode[]; dub?: RawEpisode[] } }
  >;
}

function adaptEpisodes(raw: unknown): EpisodeSummary[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((e): e is RawEpisode & { number: number } => typeof (e as RawEpisode).number === 'number')
      .map((e) => ({ number: e.number, title: e.title, thumbnail: e.thumbnail }));
  }

  const env = raw as EpisodesEnvelope;
  if (!env?.providers) return [];

  const byNumber = new Map<number, EpisodeSummary>();
  for (const data of Object.values(env.providers)) {
    for (const kind of ['sub', 'dub'] as const) {
      for (const ep of data?.episodes?.[kind] ?? []) {
        if (typeof ep.number !== 'number') continue;
        const existing = byNumber.get(ep.number) ?? { number: ep.number };
        if (kind === 'sub') existing.hasSub = true;
        else existing.hasDub = true;
        existing.title ??= ep.title;
        existing.thumbnail ??= ep.thumbnail;
        byNumber.set(ep.number, existing);
      }
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/** Kuhi API v3 client. Base URL configurable in Settings. */
export const api = {
  // Search & discovery
  search: (query: string, page = 1, perPage = 24) =>
    pagedAnime('/anime/search', { query, page, per_page: perPage }),
  suggestions: async (query: string) => {
    const raw = await request<unknown[] | { results?: unknown[] }>(
      '/anime/suggestions',
      { query },
    );
    const list = Array.isArray(raw) ? raw : (raw.results ?? []);
    return list.map(normalizeAnime).filter((s) => s.id !== 0);
  },
  genres: async () => {
    const raw = await request<string[] | { genres?: string[] }>('/anime/genres');
    return Array.isArray(raw) ? raw : (raw.genres ?? []);
  },

  // Collections
  spotlight: async (): Promise<SpotlightAnime[]> => {
    const raw = await request<unknown[] | { results?: unknown[] } | { data?: unknown[] }>('/anime/spotlight');
    const list = Array.isArray(raw) ? raw : (raw as { results?: unknown[] })?.results ?? (raw as { data?: unknown[] })?.data ?? [];
    // Kuhi returns {results:[...]} (see /usr/lib test), handle both shapes
    if (!Array.isArray(list) || list.length === 0) {
      console.warn('[kitawatch] spotlight: empty or unexpected shape', raw);
    }
    return (Array.isArray(list) ? list : []).map((s) => ({
      ...normalizeAnime(s),
      description: str((s as Raw).description),
    }));
  },
  trending: (page = 1, perPage = 24) =>
    pagedAnime('/anime/trending', { page, per_page: perPage }),
  popular: (page = 1, perPage = 24) =>
    pagedAnime('/anime/popular', { page, per_page: perPage }),
  recent: (page = 1, perPage = 24) =>
    pagedAnime('/anime/recent', { page, per_page: perPage }),
  upcoming: (page = 1, perPage = 24) =>
    pagedAnime('/anime/upcoming', { page, per_page: perPage }),
  filter: (opts: {
    genre?: string;
    year?: number;
    season?: string;
    format?: string;
    status?: string;
    sort?: FilterSort;
    page?: number;
    perPage?: number;
  }) =>
    pagedAnime('/anime/filter', {
      genre: opts.genre,
      year: opts.year,
      season: opts.season,
      format: opts.format,
      status: opts.status,
      sort: opts.sort ?? 'TRENDING_DESC',
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 24,
    }),

  // Details
  info: async (id: number | string): Promise<AnimeInfo> => {
    const raw = await request<Raw>(`/anime/info/${id}`);
    return {
      ...normalizeAnime(raw),
      synopsis: str(raw.synopsis) ?? str(raw.description),
      releaseDate: str(raw.releaseDate) ?? str(raw.startDate),
      studios: strArray(raw.studios),
    };
  },
  recommendations: (id: number | string, page = 1) =>
    pagedAnime(`/anime/anime/${id}/recommendations`, { page }),
  episodes: async (id: number | string) =>
    adaptEpisodes(await request<unknown>(`/anime/episodes/${id}`)),

  // Streaming
  extract: (query: number | string, episode: number, audio: AudioType = 'sub') =>
    request<ExtractResponse>(`/anime/extract/${encodeURIComponent(String(query))}`, {
      e: episode,
      type: audio,
    }),
  providersStatus: () => request<ProviderStatus>('/anime/providers/status'),
};

/** Proxy helpers for m3u8 playlists and segments (local sidecar). */
export const proxy = {
  m3u8: (url: string, referer = '') =>
    `${useSettingsStore.getState().proxyBaseUrl}/proxy_m3u8?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`,
  segment: (url: string, referer = '') =>
    `${useSettingsStore.getState().proxyBaseUrl}/proxy_segment?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`,
  /** Generic CORS-relay for subtitles/text (host must be allowlisted). */
  cors: (url: string) =>
    `${useSettingsStore.getState().proxyBaseUrl}/cors?u=${encodeURIComponent(url)}`,
};