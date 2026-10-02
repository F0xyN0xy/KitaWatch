// AniList mutations + list import extensions (added for auto-sync + notifications feature)
import type { AnimeSummary } from '@/types';

// Mutation: save/update media list entry (watching, completed, progress, dates)
const SAVE_LIST_ENTRY = `
mutation ($mediaId: Int!, $status: MediaListStatus, $episodes: Int, $score: Float) {
  SaveMediaListEntry (mediaId: $mediaId, status: $status, progress: $episodes, score: $score) {
    id status progress score updatedAt
  }
}`;

// Query: import full user media lists with full media metadata so entries
// display real titles/covers instead of placeholders.
const USER_LISTS_QUERY = `
query ($userName: String!, $type: MediaType) {
  MediaListCollection(userName: $userName, type: $type, status_in: [CURRENT, PLANNING, COMPLETED, DROPPED, PAUSED, REPEATING]) {
    lists {
      name
      entries {
        mediaId
        status
        progress
        score
        updatedAt
        media {
          id
          title { english romaji native }
          coverImage { large medium }
          bannerImage
          meanScore
          format
          status
          season
          seasonYear
          episodes
          genres
        }
      }
    }
  }
}`;

export interface AniListEntry {
  mediaId: number;
  status: string;
  progress: number;
  score: number;
  updatedAt: number;
  media: {
    id: number;
    title?: { english?: string; romaji?: string; native?: string };
    coverImage?: { large?: string; medium?: string };
    bannerImage?: string | null;
    meanScore?: number | null;
    format?: string;
    status?: string;
    season?: string;
    seasonYear?: number | null;
    episodes?: number | null;
    genres?: string[];
  } | null;
}

export interface AniListList {
  name: string;
  entries: AniListEntry[];
}

interface GqlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function gql<T>(query: string, variables: Record<string, unknown>, token: string): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${token.trim()}`,
  };
  const body = JSON.stringify({ query, variables });

  // Retry with backoff on 429 (rate limit) — the sidecars also hammer
  // AniList, so bursts are common. Same strategy as services/anilist.ts.
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch('https://graphql.anilist.co', {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      break;
    } catch (e) {
      lastErr = e;
      if (e instanceof DOMException && e.name === 'AbortError') {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      throw e;
    }
  }
  if (!res) {
    throw new Error(
      lastErr instanceof Error ? `AniList unreachable: ${lastErr.message}` : 'AniList unreachable',
    );
  }
  if (!res.ok) throw new Error(`AniList request failed: ${res.status}`);
  const json = (await res.json()) as GqlResponse<T>;
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  if (!json.data) throw new Error('AniList returned no data');
  return json.data;
}

/** Map a full AniList entry (with nested media) to our AnimeSummary shape. */
export function entryToAnimeSummary(entry: AniListEntry): AnimeSummary {
  const m = entry.media;
  if (!m) {
    // Fallback: entry with no media data (shouldn't happen, but stay defensive)
    return {
      id: entry.mediaId,
      title: `Anime #${entry.mediaId}`,
      status: entry.status,
    };
  }
  return {
    id: m.id,
    title: m.title?.english ?? m.title?.romaji ?? m.title?.native ?? 'Unknown title',
    cover: m.coverImage?.large ?? m.coverImage?.medium,
    banner: m.bannerImage ?? undefined,
    rating: m.meanScore != null ? m.meanScore / 10 : undefined,
    type: m.format,
    status: m.status,
    season: m.season ?? undefined,
    year: m.seasonYear ?? undefined,
    totalEpisodes: m.episodes ?? undefined,
    genres: m.genres,
  };
}

export async function saveListEntry(
  token: string,
  mediaId: number,
  status?: string,
  episodes?: number,
  score?: number,
) {
  const variables = { mediaId, status: status || undefined, episodes: episodes ?? undefined, score: score ?? undefined };
  const data = await gql<{ SaveMediaListEntry?: { id: number } }>(SAVE_LIST_ENTRY, variables, token);
  return data.SaveMediaListEntry ?? null;
}

export async function importUserLists(token: string, userName: string): Promise<AniListList[]> {
  const variables = { userName, type: 'ANIME' };
  const data = await gql<{
    MediaListCollection?: { lists?: AniListList[] };
  }>(USER_LISTS_QUERY, variables, token);
  return data.MediaListCollection?.lists ?? [];
}

// ─── Notifications ────────────────────────────────────────────────────────────

const NOTIFICATIONS_QUERY = `
query ($page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    notifications: notification {
      ... on AiringNotification {
        id
        type
        animeId
        episode
        contexts
        createdAt
        media { id title { english romaji } coverImage { large } }
      }
      ... on FollowingNotification {
        id
        type
        createdAt
        user { id name avatar { large } }
      }
      ... on ActivityLikeNotification {
        id
        type
        createdAt
        user { id name avatar { large } }
      }
      ... on ActivityReplyNotification {
        id
        type
        createdAt
        user { id name avatar { large } }
      }
      ... on ActivityMentionNotification {
        id
        type
        createdAt
        user { id name avatar { large } }
      }
      ... on RelatedMediaAdditionNotification {
        id
        type
        createdAt
        media { id title { english romaji } coverImage { large } }
      }
      ... on MediaDataChangeNotification {
        id
        type
        createdAt
        media { id title { english romaji } coverImage { large } }
      }
      ... on MediaMergeNotification {
        id
        type
        createdAt
        media { id title { english romaji } coverImage { large } }
      }
      ... on MediaDeletionNotification {
        id
        type
        createdAt
        deletedMediaTitle: contexts
      }
    }
  }
}`;

export interface AniNotification {
  id: number;
  type: string;
  createdAt: number;
  /** AiringNotification fields */
  animeId?: number;
  episode?: number;
  contexts?: string[];
  /** Related media */
  media?: {
    id: number;
    title?: { english?: string; romaji?: string };
    coverImage?: { large?: string };
  } | null;
  /** User who triggered the notification (follow, like, reply, mention) */
  user?: {
    id: number;
    name: string;
    avatar?: { large?: string } | null;
  } | null;
  /** MediaDeletionNotification */
  deletedMediaTitle?: string[];
}

export async function fetchNotifications(token: string, perPage = 15): Promise<AniNotification[]> {
  const data = await gql<{
    Page?: { notifications?: AniNotification[] };
  }>(NOTIFICATIONS_QUERY, { page: 1, perPage }, token);
  return data.Page?.notifications ?? [];
}
