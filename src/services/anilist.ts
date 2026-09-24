import type { AnimeInfo, AnimeSummary } from '@/types';
import { invoke } from '@tauri-apps/api/core';
import { useAuthStore, DEFAULT_REDIRECT } from '@/stores/authStore';

const API_URL = 'https://graphql.anilist.co';
/** Public OAuth client ID — identifies the app; users still log in with THEIR account. */
export const ANILIST_CLIENT_ID = '34664';
export const OAUTH_AUTHORIZE = 'https://anilist.co/api/v2/oauth/authorize';
/** Redirect URI — must exactly match the AniList client's registered URL. */
export function getRedirectUri(): string {
  return useAuthStore.getState().anilistRedirect?.trim() || DEFAULT_REDIRECT;
}

export class AniListError extends Error {}

/** Strip the HTML tags AniList puts in descriptions. */
function stripHtml(html: string): string {
  const div = document.createElement('div');
  div.innerHTML = html;
  return (div.textContent ?? '').replace(/\s+/g, ' ').trim();
}

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(
  query: string,
  variables: Record<string, unknown> = {},
  token?: string | null,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token.trim()}`;

  // 10s hard timeout — a hung fetch must never leave a page loading forever
  // AbortSignal.timeout is not available in older WebKitGTK (4.0); fallback to manual AbortController
  const withTimeout = (ms: number): AbortSignal | undefined => {
    try {
      // @ts-ignore - newer runtimes
      if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
    } catch {}
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };
  const attempt = () =>
    fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: withTimeout(10_000),
    });
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attemptN = 0; attemptN < 3; attemptN++) {
    try {
      res = await attempt();
      if (res.status === 429) {
        // rate-limited (sidecars hammer AniList too) — back off and retry
        await new Promise((r) => setTimeout(r, 1500 * (attemptN + 1)));
        continue;
      }
      break;
    } catch (e) {
      lastErr = e;
      if (e instanceof DOMException && e.name === 'AbortError') {
        await new Promise((r) => setTimeout(r, 800 * (attemptN + 1)));
        continue;
      }
      throw e;
    }
  }
  if (!res) {
    throw new AniListError(
      lastErr instanceof Error ? `AniList unreachable: ${lastErr.message}` : 'AniList unreachable',
    );
  }
  if (res.status === 401) throw new AniListError('AniList session expired — reconnect');
  if (!res.ok) throw new AniListError(`AniList responded ${res.status}`);
  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors?.length) {
    throw new AniListError(json.errors.map((e) => e.message).join('; '));
  }
  if (!json.data) throw new AniListError('AniList returned no data');
  return json.data;
}

const INFO_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id
    title { romaji english native }
    coverImage { large medium }
    bannerImage
    description(asHtml: false)
    genres
    meanScore
    format
    status
    season
    seasonYear
    episodes
    startDate { year month day }
    studios(isMain: true) { nodes { name } }
  }
}`;

const VIEWER_QUERY = `
query {
  Viewer { id name avatar { large } }
}`;

const FAVORITES_QUERY = `
query ($name: String!) {
  User(name: $name) {
    favourites {
      anime(perPage: 50) {
        nodes { id title { english romaji } coverImage { large } meanScore format }
      }
    }
  }
}`;

const RECOMMENDATIONS_QUERY = `
query ($id: Int) {
  Media(id: $id, type: ANIME) {
    recommendations(sort: RATING_DESC, perPage: 14) {
      nodes {
        mediaRecommendation {
          id
          title { english romaji }
          coverImage { large }
          format
        }
      }
    }
  }
}`;

const SEARCH_QUERY = `
query ($q: String) {
  Page(page: 1, perPage: 7) {
    results: media(type: ANIME, search: $q) {
      id
      title { english romaji }
      coverImage { large }
      format
    }
  }
}`;

const TOGGLE_FAV_MUTATION = `
mutation ($id: Int!) {
  ToggleFavourite(animeId: $id) { anime { nodes { id } } }
}`;

interface RawMedia {
  id?: number;
  title?: { romaji?: string; english?: string; native?: string };
  coverImage?: { large?: string; medium?: string };
  bannerImage?: string | null;
  description?: string | null;
  genres?: string[];
  meanScore?: number | null;
  format?: string;
  status?: string;
  season?: string;
  seasonYear?: number | null;
  episodes?: number | null;
  startDate?: { year?: number | null };
  studios?: { nodes?: { name?: string }[] };
}

/** Full anime metadata, straight from AniList — legal, stable, no middleman. */
export const anilist = {
  info: async (id: number | string): Promise<AnimeInfo> => {
    const data = await gql<{ Media: RawMedia | null }>(INFO_QUERY, { id: Number(id) });
    const m = data.Media;
    if (!m?.id) throw new AniListError(`No AniList entry for id ${id}`);

    return {
      id: m.id,
      title: m.title?.english ?? m.title?.romaji ?? m.title?.native ?? 'Unknown title',
      cover: m.coverImage?.large ?? m.coverImage?.medium,
      banner: m.bannerImage ?? undefined,
      synopsis: m.description ? stripHtml(m.description) : undefined,
      genres: m.genres,
      rating: m.meanScore != null ? m.meanScore / 10 : undefined,
      type: m.format,
      status: m.status,
      season: m.season ?? undefined,
      year: m.seasonYear ?? undefined,
      totalEpisodes: m.episodes ?? undefined,
      releaseDate: m.startDate?.year ? String(m.startDate.year) : undefined,
      studios: m.studios?.nodes?.map((s) => s.name).filter((n): n is string => !!n),
    };
  },

  /** Top community recommendations for an anime — AniList direct (covers guaranteed). */
  recommendations: async (id: number | string): Promise<AnimeSummary[]> => {
    const data = await gql<{
      Media?: {
        recommendations?: {
          nodes?: {
            mediaRecommendation?: {
              id?: number;
              title?: { english?: string; romaji?: string };
              coverImage?: { large?: string };
              format?: string;
            } | null;
          }[];
        };
      };
    }>(RECOMMENDATIONS_QUERY, { id: Number(id) });
    return (data.Media?.recommendations?.nodes ?? [])
      .map((n) => n.mediaRecommendation)
      .filter((m): m is NonNullable<typeof m> & { id: number } => !!m && typeof m.id === 'number')
      .map((m) => ({
        id: m.id,
        title: m.title?.english ?? m.title?.romaji ?? 'Unknown title',
        cover: m.coverImage?.large,
        type: m.format,
      }));
  },

  /** Fast autocomplete — AniList direct (much snappier than the sidecar). */
  search: async (q: string): Promise<AnimeSummary[]> => {
    const data = await gql<{
      Page: {
        results: {
          id: number;
          title?: { english?: string; romaji?: string };
          coverImage?: { large?: string };
          format?: string;
        }[];
      };
    }>(SEARCH_QUERY, { q });
    return data.Page.results.map((m) => ({
      id: m.id,
      title: m.title?.english ?? m.title?.romaji ?? 'Unknown title',
      cover: m.coverImage?.large,
      type: m.format,
    }));
  },

  /** Logged-in user profile. */
  viewer: (token: string) =>
    gql<{ Viewer: { id: number; name: string; avatar?: { large?: string } | null } }>(
      VIEWER_QUERY,
      {},
      token,
    ),

  /** The user's AniList favorites, mapped to our AnimeSummary shape. */
  importFavorites: async (token: string, username: string): Promise<AnimeSummary[]> => {
    const data = await gql<{
      User?: {
        favourites?: {
          anime?: {
            nodes?: {
              id?: number;
              title?: { english?: string; romaji?: string };
              coverImage?: { large?: string };
              meanScore?: number | null;
              format?: string;
            }[];
          };
        };
      };
    }>(FAVORITES_QUERY, { name: username }, token);

    const nodes = data.User?.favourites?.anime?.nodes ?? [];
    return nodes
      .filter((n): n is typeof n & { id: number } => typeof n.id === 'number')
      .map((n) => ({
        id: n.id,
        title: n.title?.english ?? n.title?.romaji ?? 'Unknown title',
        cover: n.coverImage?.large,
        rating: n.meanScore != null ? n.meanScore / 10 : undefined,
        type: n.format,
      }));
  },

  /** Push a favorite toggle to AniList (fire-and-forget). */
  toggleFavorite: (token: string, id: number) =>
    gql(TOGGLE_FAV_MUTATION, { id: Number(id) }, token).then(() => undefined),
};

/** Open the AniList authorize page in the system browser. */
export async function startAniListOAuth(): Promise<void> {
  const url =
    `${OAUTH_AUTHORIZE}?client_id=${encodeURIComponent(ANILIST_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(getRedirectUri())}&response_type=code`;
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
  } catch {
    window.open(url, '_blank', 'noopener'); // browser-only dev fallback
  }
}

/**
 * Trade the deep-link callback code for an access token.
 * Desktop: the Rust command does it (secret stays out of frontend code).
 * Environment variables (.env) win; the values stored in Settings are the
 * fallback so the installed app works where no .env exists.
 */
export async function exchangeAuthCode(code: string): Promise<string> {
  const { anilistRedirect } = useAuthStore.getState();
  try {
    return await invoke<string>('exchange_anilist_token', {
      code,
      clientId: ANILIST_CLIENT_ID,
      clientSecret: null,
      redirectUri: anilistRedirect || null,
    });
  } catch (e) {
    throw new AniListError(e instanceof Error ? e.message : String(e));
  }
}
