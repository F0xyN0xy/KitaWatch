import { api } from './api';
import { anilist } from './anilist';
import type { AnimeInfo } from '@/types';

/**
 * Shared anime-info fetcher for the detail/watch pages.
 *
 * AniList is queried first; the local Kuhi API is the network fallback.
 * Successful results are also persisted locally so a temporary AniList/Kuhi
 * outage doesn't leave previously viewed anime without metadata after restart.
 * Cached data is stale-while-revalidate: it renders immediately and refreshes
 * quietly in the background.
 *
 * Concurrent callers for the same id share a single in-flight request.
 */

const STORAGE_KEY = 'kitawatch-anime-info-cache-v1';
const MAX_PERSISTED_ENTRIES = 100;

interface PersistedEntry {
  savedAt: number;
  data: AnimeInfo;
}

const cache = new Map<string, AnimeInfo>();
const inflight = new Map<string, Promise<AnimeInfo>>();
const refreshing = new Set<string>();

/** localStorage may be unavailable in restricted webviews; cache is optional. */
function readPersistedCache(id: string): AnimeInfo | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const entries = JSON.parse(raw) as Record<string, PersistedEntry>;
    const entry = entries[id];
    if (
      !entry ||
      !entry.data ||
      Number(entry.data.id) !== Number(id) ||
      typeof entry.data.title !== 'string' ||
      !entry.data.title.trim()
    ) {
      return undefined;
    }
    return entry.data;
  } catch {
    return undefined;
  }
}

function writePersistedCache(id: string, data: AnimeInfo): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const entries = raw ? (JSON.parse(raw) as Record<string, PersistedEntry>) : {};
    entries[id] = { savedAt: Date.now(), data };

    // Keep the most recently updated records to bound storage growth.
    const retained = Object.entries(entries)
      .filter(([, entry]) => entry && typeof entry.savedAt === 'number' && entry.data)
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, MAX_PERSISTED_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(retained)));
  } catch {
    // A full or unavailable storage area must never break metadata loading.
  }
}

/** AniList first; Kuhi is the fallback when GraphQL is unavailable. */
const loadFresh = (id: string) => anilist.info(id).catch(() => api.info(id));

function refreshQuietly(id: string): void {
  if (refreshing.has(id)) return;
  refreshing.add(id);
  void loadFresh(id)
    .then((data) => {
      cache.set(id, data);
      writePersistedCache(id, data);
    })
    .catch(() => {
      // Keep the last successful copy when both upstreams are unavailable.
    })
    .finally(() => refreshing.delete(id));
}

export function fetchAnimeInfo(id: string): Promise<AnimeInfo> {
  const memoryHit = cache.get(id);
  if (memoryHit) {
    refreshQuietly(id);
    return Promise.resolve(memoryHit);
  }

  const persistedHit = readPersistedCache(id);
  if (persistedHit) {
    cache.set(id, persistedHit);
    refreshQuietly(id);
    return Promise.resolve(persistedHit);
  }

  const existing = inflight.get(id);
  if (existing) return existing;

  const request = loadFresh(id)
    .then((data) => {
      cache.set(id, data);
      writePersistedCache(id, data);
      return data;
    })
    .finally(() => inflight.delete(id));

  inflight.set(id, request);
  return request;
}

/** Synchronous cache peek — for places that want to render before fetching. */
export function peekAnimeInfo(id: string): AnimeInfo | undefined {
  return cache.get(id) ?? readPersistedCache(id);
}
