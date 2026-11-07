import { isSupabaseConfigured, supabase } from '@/lib/supabase';

let guestSessionPromise: Promise<boolean> | null = null;

/**
 * Ensure this installation has a Supabase identity.
 *
 * Existing permanent and anonymous sessions are preserved. When no session
 * exists, the caller must first obtain a one-time hCaptcha token.
 *
 * Returns false when a guest session is needed but no CAPTCHA token has been
 * supplied yet.
 */
export async function ensureGuestSession(captchaToken?: string): Promise<boolean> {
  if (!isSupabaseConfigured || !supabase) return false;

  if (guestSessionPromise) return guestSessionPromise;

  guestSessionPromise = (async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;

    // Never replace an existing Discord/permanent account or guest session.
    if (data.session) return true;

    if (!captchaToken) return false;

    const { error: signInError } = await supabase.auth.signInAnonymously({
      options: { captchaToken },
    });
    if (signInError) throw signInError;

    return true;
  })();

  try {
    return await guestSessionPromise;
  } finally {
    guestSessionPromise = null;
  }
}
