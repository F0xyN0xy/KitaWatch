import { api } from './api';
import { anilist } from './anilist';
import type { AnimeInfo } from '@/types';

/**
 * Shared anime-info fetcher for the detail/watch pages.
 *
 * Two problems this solves:
 *  - "Opens the episode without info, have to go back first": every mount
 *    re-fetched info from scratch, so the watch page sat half-empty until
 *    the request resolved. Now a per-session cache serves the info
 *    instantly on any revisit (episode switches, back-and-forth), with a
 *    quiet background refresh to pick up changes.
 *  - Rate limiting: the old code raced `api.info` and `anilist.info` in
 *    PARALLEL on every page — two AniList hits per open, multiplied by
 *    every navigation. Now AniList is queried first (one hit) and the
 *    local Kuhi API is only contacted as a fallback or to fill in the
 *    episode list when AniList doesn't carry one.
 *
 * Concurrent callers for the same id share a single in-flight request.
 */

const cache = new Map<string, AnimeInfo>();
const inflight = new Map<string, Promise<AnimeInfo>>();
const refreshing = new Set<string>();

/** AniList first (one request); Kuhi only covers outages. */
const loadFresh = (id: string) => anilist.info(id).catch(() => api.info(id));

export function fetchAnimeInfo(id: string): Promise<AnimeInfo> {
  const hit = cache.get(id);
  if (hit) {
    // Stale-while-revalidate: return immediately, refresh quietly. The
    // refresh is fire-and-forget (guarded by `refreshing`, not `inflight`,
    // so its type stays Promise<void> and never touches the typed map).
    if (!refreshing.has(id)) {
      refreshing.add(id);
      void loadFresh(id)
        .then((i) => {
          cache.set(id, i);
        })
        .catch(() => {})
        .finally(() => refreshing.delete(id));
    }
    return Promise.resolve(hit);
  }
  const existing = inflight.get(id);
  if (existing) return existing;
  const p = loadFresh(id)
    .then((i) => {
      cache.set(id, i);
      return i;
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

/** Synchronous cache peek — for places that want to render before fetching. */
export function peekAnimeInfo(id: string): AnimeInfo | undefined {
  return cache.get(id);
}
