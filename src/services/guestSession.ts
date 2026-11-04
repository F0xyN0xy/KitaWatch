import { isSupabaseConfigured, supabase } from '@/lib/supabase';

let guestSessionPromise: Promise<void> | null = null;

/**
 * Ensure every installation has a Supabase identity for private data and
 * leaderboard participation. Existing permanent and anonymous sessions are
 * always preserved.
 */
export async function ensureGuestSession(): Promise<void> {
  if (!isSupabaseConfigured || !supabase) return;

  if (guestSessionPromise) return guestSessionPromise;

  guestSessionPromise = (async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;

    // Never replace an existing Discord/permanent account or guest session.
    if (data.session) return;

    const { error: signInError } = await supabase.auth.signInAnonymously();
    if (signInError) throw signInError;
  })();

  try {
    await guestSessionPromise;
  } finally {
    guestSessionPromise = null;
  }
}
