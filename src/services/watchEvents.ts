import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { ensureGuestSession } from '@/services/guestSession';

interface RecordWatchEventInput {
  clientEventId: string;
  animeId: number;
  episodeNumber: number;
  watchedSeconds: number;
  episodeDurationSeconds: number;
}

/**
 * Record one qualifying playback event for the authenticated Supabase user.
 * The database function validates the threshold, duration, rate limit and
 * duplicate event constraints; this client helper never writes watch_events
 * directly.
 */
export async function recordWatchEvent(input: RecordWatchEventInput): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;

  await ensureGuestSession();

  const { error } = await supabase.rpc('record_watch_event', {
    p_client_event_id: input.clientEventId,
    p_anime_id: input.animeId,
    p_episode_number: input.episodeNumber,
    p_watched_seconds: Math.floor(input.watchedSeconds),
    p_episode_duration_seconds: Math.round(input.episodeDurationSeconds),
  });

  if (error) throw error;
}
