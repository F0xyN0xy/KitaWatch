import { useSettingsStore } from '@/stores/settingsStore';
import { anivexa } from '@/services/anivexa';
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

// ── Adult content ────────────────────────────────────────────
// Hentai is filtered out of discovery by default. Two explicit signals
// override the filter:
//   1. the "Show adult content" toggle in Settings
//   2. the user asking for hentai directly — typing "hentai" in the
//      search box, or picking the Hentai genre filter in Browse
// Direct ID access (details, watch, own favorites) is never filtered.

const ADULT_INTENT_RE = /hentai|adult(?:\s+content)?|18\+/i;

/** Detect explicit adult-search intent so Browse can show the maintenance notice. */
export function isAdultSearchIntent(value?: string): boolean {
  return !!value && ADULT_INTENT_RE.test(value);
}

export function adultContentAllowed(_explicit?: string): boolean {
  // Adult content providers are permanently under maintenance until a future update.
  return false;
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
  /** The user's own words (search text) or chosen genre — "hentai" unblocks. */
  explicit?: string,
): Promise<Paged<AnimeSummary>> {
  const p = await paged<unknown>(path, params);
  const results = p.results.map(normalizeAnime);
  const allowAdult = adultContentAllowed(explicit);
  // NOTE: client-side filtering can thin out a page (fewer than perPage
  // items, occasionally an empty "Load more" page at the tail). Accepted
  // for now — the Kuhi API has no server-side exclude-genre parameter.
  return {
    ...p,
    results: allowAdult ? results : results.filter((a) => !a.isAdult),
  };
}

// ── Episodes adapter ─────────────────────────────────────────
// v3 shape: { providers: { anineko: { episodes: { sub: [...], dub: [...] } }, ... } }
// Tolerates a flat array from older instances.

interface RawEpisode {
  number?: number;
  title?: string | null;
  thumbnail?: string | null;
  /** Kuhi v3 provider payloads call episode artwork "image". */
  image?: string | null;
}

interface EpisodesEnvelope {
  providers?: Record<
    string,
    {
      meta?: { matchScore?: number };
      episodes?: { sub?: RawEpisode[]; dub?: RawEpisode[] };
    }
  >;
}

function meaningfulEpisodeTitle(value: string | null | undefined): string | undefined {
  const title = value?.trim();
  if (!title || /^episode\s+\d+$/i.test(title)) return undefined;
  return title;
}

function adaptEpisodes(raw: unknown): EpisodeSummary[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((e): e is RawEpisode & { number: number } => typeof (e as RawEpisode).number === 'number')
      .map((e) => ({
        number: e.number,
        title: meaningfulEpisodeTitle(e.title),
        thumbnail: e.thumbnail?.trim() || e.image?.trim() || undefined,
      }));
  }

  const env = raw as EpisodesEnvelope;
  if (!env?.providers) return [];

  const byNumber = new Map<number, EpisodeSummary>();
  // Prefer providers with stronger anime matches, but merge all providers so
  // a generic "Episode N" entry cannot hide a real title or episode image.
  const providers = Object.values(env.providers).sort(
    (a, b) => (b.meta?.matchScore ?? 0) - (a.meta?.matchScore ?? 0),
  );
  for (const data of providers) {
    for (const kind of ['sub', 'dub'] as const) {
      for (const ep of data?.episodes?.[kind] ?? []) {
        if (typeof ep.number !== 'number') continue;
        const existing = byNumber.get(ep.number) ?? { number: ep.number };
        if (kind === 'sub') existing.hasSub = true;
        else existing.hasDub = true;
        const title = meaningfulEpisodeTitle(ep.title);
        if (title && (!existing.title || /^episode\s+\d+$/i.test(existing.title))) {
          existing.title = title;
        }
        const image = ep.thumbnail?.trim() || ep.image?.trim();
        if (image && !existing.thumbnail) existing.thumbnail = image;
        byNumber.set(ep.number, existing);
      }
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}


// MAL/Jikan episode-title enrichment. The provider API remains the primary source;
// Jikan fills generic/missing titles only, so it cannot overwrite provider titles.
interface JikanEpisode {
  /** Jikan's episode-list endpoint uses mal_id for the episode number. */
  mal_id?: number | null;
  title?: string | null;
  title_romanji?: string | null;
  title_japanese?: string | null;
}

interface JikanEpisodesResponse {
  data?: JikanEpisode[];
  pagination?: { has_next_page?: boolean };
}

const providerEpisodeCache = new Map<number, Promise<EpisodeSummary[]>>();
const jikanEpisodePageCache = new Map<string, Promise<EpisodeSummary[]>>();

function providerEpisodesFor(id: number): Promise<EpisodeSummary[]> {
  const cached = providerEpisodeCache.get(id);
  if (cached) return cached;
  const pending = request<unknown>(`/anime/episodes/${id}`)
    .then(adaptEpisodes)
    .catch((error) => {
      providerEpisodeCache.delete(id);
      throw error;
    });
  providerEpisodeCache.set(id, pending);
  return pending;
}

async function fetchJikanEpisodePage(malId: number, page: number): Promise<EpisodeSummary[]> {
  const key = `${malId}:${page}`;
  const cached = jikanEpisodePageCache.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(
        `https://api.jikan.moe/v4/anime/${malId}/episodes?page=${page}`,
        { signal: controller.signal, headers: { Accept: 'application/json' } },
      );
      if (!response.ok) throw new Error(`Jikan HTTP ${response.status}`);
      const payload = (await response.json()) as JikanEpisodesResponse;
      return (payload.data ?? [])
        .filter((item) => typeof item.mal_id === 'number' && item.mal_id > 0)
        .map((item) => ({
          number: item.mal_id!,
          title: meaningfulEpisodeTitle(item.title) ??
            meaningfulEpisodeTitle(item.title_romanji) ??
            meaningfulEpisodeTitle(item.title_japanese),
        }))
        .filter((item) => !!item.title);
    } finally {
      clearTimeout(timer);
    }
  })().catch((error) => {
    // Only cache successful responses so temporary rate limits/outages can recover.
    jikanEpisodePageCache.delete(key);
    throw error;
  });

  jikanEpisodePageCache.set(key, pending);
  return pending;
}

async function fetchExternalEpisodeTitles(
  anilistId: number,
  episode: number,
): Promise<EpisodeSummary[]> {
  const mapping = await anivexa.mapAnime(anilistId);
  const malId = mapping.mappings?.malId;
  if (!malId || !Number.isSafeInteger(malId) || malId <= 0) return [];
  // Jikan paginates episode lists at 100 entries per page. Fetch only the
  // page needed for the currently visible 100-episode block.
  return fetchJikanEpisodePage(malId, Math.max(1, Math.ceil(episode / 100)));
}

async function loadEpisodes(id: number, episode: number): Promise<EpisodeSummary[]> {
  // Provider metadata is the primary source for both episode titles and
  // episode-specific artwork. Return it as soon as it is available rather
  // than making the UI wait for an optional external metadata service.
  const providerPromise = providerEpisodesFor(id);
  const titlePromise = fetchExternalEpisodeTitles(id, episode).catch((error) => {
    console.warn('[KitaWatch] Could not load MAL episode titles:', error);
    return [] as EpisodeSummary[];
  });

  const providerResult = await Promise.allSettled([providerPromise]);
  if (providerResult[0].status === 'rejected') {
    // If the provider API fails, external titles can still provide useful
    // episode labels. Do not discard them while waiting for the fallback.
    const externalTitles = await titlePromise;
    if (externalTitles.length === 0) throw providerResult[0].reason;
    return externalTitles;
  }

  const byNumber = new Map<number, EpisodeSummary>();
  for (const item of providerResult[0].value) byNumber.set(item.number, { ...item });

  // Merge optional MAL titles without delaying provider artwork/titles.
  // Provider metadata remains authoritative whenever it has a meaningful title.
  void titlePromise.then((externalTitles) => {
    for (const item of externalTitles) {
      const existing = byNumber.get(item.number);
      if (existing && !meaningfulEpisodeTitle(existing.title) && item.title) {
        existing.title = item.title;
      }
    }
  });

  return [...byNumber.values()].sort((left, right) => left.number - right.number);
}

/** Kuhi API v3 client. Base URL configurable in Settings. */
export const api = {
  // Search & discovery
  search: (query: string, page = 1, perPage = 24) =>
    pagedAnime('/anime/search', { query, page, per_page: perPage }, query),
  suggestions: async (query: string) => {
    const raw = await request<unknown[] | { results?: unknown[] }>(
      '/anime/suggestions',
      { query },
    );
    const list = Array.isArray(raw) ? raw : (raw.results ?? []);
    const allowAdult = adultContentAllowed(query);
    return list
      .map(normalizeAnime)
      .filter((s) => s.id !== 0)
      .filter((s) => allowAdult || !s.isAdult);
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
    const allowAdult = adultContentAllowed();
    return (Array.isArray(list) ? list : [])
      .map((s) => ({
        ...normalizeAnime(s),
        description: str((s as Raw).description),
      }))
      .filter((s) => allowAdult || !s.isAdult);
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
    pagedAnime(
      '/anime/filter',
      {
        genre: opts.genre,
        year: opts.year,
        season: opts.season,
        format: opts.format,
        status: opts.status,
        sort: opts.sort ?? 'TRENDING_DESC',
        page: opts.page ?? 1,
        per_page: opts.perPage ?? 24,
      },
      // Picking the Hentai genre IS the explicit search — let it through.
      opts.genre,
    ),

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
  episodes: (id: number | string, episode = 1) =>
    loadEpisodes(Number(id), Math.max(1, Number(episode) || 1)),

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