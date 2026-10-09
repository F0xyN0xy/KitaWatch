// AniList watch-progress auto-sync.
//
// The mutation helper (saveListEntry) lived in anilistSync.ts for a while but
// NOTHING called it — the "automatic updater" was a no-op. This module is the
// missing caller: it decides WHEN progress may be pushed and de-dupes the
// pushes so a binge session doesn't hammer the API.
//
// Policy:
//  - Only push when the user is logged in (obviously).
//  - Only push when the anime is on the user's list OR they enabled
//    "auto-add to list" behaviour implicitly by watching (we push with
//    status=CURRENT, which AniList creates-if-missing).
//  - H (adult) titles are pushed ONLY when updateAdultProgress is on.
//    The flag travels with the AnimeInfo that the watch page already fetched,
//    so no extra request is needed to make the decision.
//  - Progress is monotonic: we never push a LOWER number than what we last
//    pushed for the same media id this session, and we skip no-op pushes
//    (same value twice). AniList itself rejects regressions, but avoiding
//    the round-trip keeps us clear of the rate limiter.
//  - Failures are swallowed with a console warning — a sync hiccup must
//    never break playback.

import { saveListEntry } from './anilistSync';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';

/** Last value we pushed per media id this session (monotonic guard). */
const pushed = new Map<number, number>();

/** Forget a media id (e.g. user removed it from their list). */
export function resetPushedProgress(mediaId: number): void {
  pushed.delete(mediaId);
}

/**
 * May we push progress for this anime right now?
 * Cheap, synchronous — reads only local stores.
 */
export function mayPushProgress(isAdult: boolean | undefined): boolean {
  const { accessToken } = useAuthStore.getState();
  if (!accessToken) return false;
  // undefined isAdult = unknown; treat as non-adult (regular anime) so the
  // common path keeps working. The explicit `true` only comes from AniList.
  if (isAdult === true && !useSettingsStore.getState().updateAdultProgress) {
    return false;
  }
  return true;
}

/**
 * Push "watched up to episode N" for a media id.
 * Fire-and-forget: awaits nothing the caller cares about, never throws.
 *
 * @param mediaId  AniList media id
 * @param episode  Latest episode the user has watched
 * @param isAdult  From AnimeInfo.isAdult — gates on the user's H-toggle
 */
export function pushProgress(mediaId: number, episode: number, isAdult?: boolean): void {
  if (!mayPushProgress(isAdult)) return;
  if (!Number.isFinite(mediaId) || mediaId <= 0) return;
  if (!Number.isFinite(episode) || episode < 1) return;

  const last = pushed.get(mediaId);
  if (last !== undefined && episode <= last) return;
  pushed.set(mediaId, episode);

  const { accessToken } = useAuthStore.getState();
  if (!accessToken) return; // mayPushProgress already checked; belt & braces

  // status: CURRENT — AniList creates the list entry if none exists, so
  // first-time watchers get added to "Watching" automatically.
  saveListEntry(accessToken, mediaId, 'CURRENT', episode)
    .catch((e: unknown) => {
      // Roll back the guard so a retried episode isn't wrongly skipped.
      const prev = pushed.get(mediaId);
      if (prev === episode) {
        if (last === undefined) pushed.delete(mediaId);
        else pushed.set(mediaId, last);
      }
      console.warn('[progressSync] AniList push failed:', e);
    });
}