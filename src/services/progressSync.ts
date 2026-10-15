// AniList watch-progress auto-sync.
//
// Progress is committed only after the player reports that an episode ended.
// Before writing, read the user's existing AniList entry and never replace a
// higher progress value with a lower one. Per-media writes are serialized so
// overlapping ended events cannot race and regress progress.
//
// Policy:
//  - Only push when the user is logged in.
//  - Only push when an episode ends; loading metadata / starting playback is
//    not enough to count an episode as watched.
//  - H (adult) titles are pushed ONLY when updateAdultProgress is enabled.
//  - Existing AniList progress is monotonic. Existing list status is preserved;
//    a missing entry is created as CURRENT.
//  - Failures are swallowed with a console warning — sync must never break playback.

import { saveListEntry } from './anilistSync';
import { useAuthStore } from '@/stores/authStore';
import { useSettingsStore } from '@/stores/settingsStore';

interface RemoteProgress {
  progress: number;
  status: string;
}

/** Last value successfully pushed or observed per media id this session. */
const pushed = new Map<number, number>();
/** Serialize writes per media id to prevent out-of-order mutations. */
const pending = new Map<number, Promise<void>>();

const ENTRY_PROGRESS_QUERY = `
query ($mediaId: Int!, $userId: Int!) {
  MediaList(mediaId: $mediaId, userId: $userId) {
    progress
    status
  }
}`;

async function fetchRemoteProgress(
  token: string,
  mediaId: number,
  userId: number,
): Promise<RemoteProgress | null> {
  const response = await fetch('https://graphql.anilist.co', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token.trim()}`,
    },
    body: JSON.stringify({
      query: ENTRY_PROGRESS_QUERY,
      variables: { mediaId, userId },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) throw new Error(`AniList progress lookup failed: ${response.status}`);

  const json = (await response.json()) as {
    data?: { MediaList?: RemoteProgress | null };
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    throw new Error(json.errors.map((error) => error.message).join('; '));
  }
  if (!json.data) throw new Error('AniList returned no progress data');
  return json.data.MediaList ?? null;
}

/** Forget a media id (e.g. user removed it from their list). */
export function resetPushedProgress(mediaId: number): void {
  pushed.delete(mediaId);
}

/** May we push progress for this anime right now? */
export function mayPushProgress(isAdult: boolean | undefined): boolean {
  const { accessToken } = useAuthStore.getState();
  if (!accessToken) return false;
  // Unknown adult status follows the existing regular-anime path; only an
  // explicit true is gated by the user's adult-progress setting.
  if (isAdult === true && !useSettingsStore.getState().updateAdultProgress) {
    return false;
  }
  return true;
}

/**
 * Push "watched up to episode N" after the episode ends.
 * Fire-and-forget: failures are logged and never interrupt playback.
 */
export function pushProgress(mediaId: number, episode: number, isAdult?: boolean): void {
  if (!mayPushProgress(isAdult)) return;
  if (!Number.isFinite(mediaId) || mediaId <= 0) return;
  if (!Number.isFinite(episode) || episode < 1) return;

  const { accessToken, viewer } = useAuthStore.getState();
  if (!accessToken || !viewer?.id) return;

  const previous = pending.get(mediaId) ?? Promise.resolve();
  const task = previous
    .catch(() => {
      // A failed earlier episode must not block future progress updates.
    })
    .then(async () => {
      const lastPushed = pushed.get(mediaId);
      if (lastPushed !== undefined && episode <= lastPushed) return;

      const remote = await fetchRemoteProgress(accessToken, mediaId, viewer.id);
      if (remote && episode <= remote.progress) {
        // The user may already be further along on AniList or another device.
        // Remember the higher value locally and do not send a regression.
        pushed.set(mediaId, remote.progress);
        return;
      }

      // Preserve an existing status (e.g. COMPLETED or PAUSED). Only new
      // entries need CURRENT so first-time watchers are added to their list.
      await saveListEntry(
        accessToken,
        mediaId,
        remote ? undefined : 'CURRENT',
        episode,
      );
      pushed.set(mediaId, episode);
    })
    .catch((error: unknown) => {
      console.warn('[progressSync] AniList push failed:', error);
    })
    .finally(() => {
      if (pending.get(mediaId) === task) pending.delete(mediaId);
    });

  pending.set(mediaId, task);
}
