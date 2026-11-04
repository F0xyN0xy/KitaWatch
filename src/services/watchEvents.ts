import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { ensureGuestSession } from '@/services/guestSession';

interface RecordPlaybackProgressInput {
  clientEventId: string;
  sessionId: string;
  animeId: number;
  episodeNumber: number;
  positionSeconds: number;
  watchedSecondsDelta: number;
  episodeDurationSeconds: number;
}

/**
 * Persist a small, measured playback interval. The database deduplicates
 * clientEventId and accumulates progress across player/app sessions.
 */
export async function recordPlaybackProgress(
  input: RecordPlaybackProgressInput,
): Promise<{ watchedSeconds: number; completed: boolean }> {
  if (!isSupabaseConfigured || !supabase) {
    return { watchedSeconds: 0, completed: false };
  }

  await ensureGuestSession();

  const { data, error } = await supabase.rpc('record_playback_progress', {
    p_client_event_id: input.clientEventId,
    p_session_id: input.sessionId,
    p_anime_id: input.animeId,
    p_episode_number: input.episodeNumber,
    p_position_seconds: Math.max(0, Math.floor(input.positionSeconds)),
    p_watched_seconds_delta: Math.max(1, Math.floor(input.watchedSecondsDelta)),
    p_episode_duration_seconds: Math.round(input.episodeDurationSeconds),
  });

  if (error) throw error;

  const result = Array.isArray(data) ? data[0] : data;
  return {
    watchedSeconds: Number(result?.watched_seconds) || 0,
    completed: Boolean(result?.completed),
  };
}
