import { openUrl } from '@tauri-apps/plugin-opener';
import type { User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { parseDiscordAuthCallback } from '@/services/discordAuthUrl';

export interface DiscordIdentity {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

export function discordIdentityFromUser(user: User): DiscordIdentity {
  const metadata = user.user_metadata ?? {};
  const displayName =
    metadata.global_name ||
    metadata.full_name ||
    metadata.name ||
    metadata.preferred_username ||
    'Discord user';

  return {
    id: user.id,
    displayName: String(displayName),
    avatarUrl:
      typeof metadata.avatar_url === 'string'
        ? metadata.avatar_url
        : typeof metadata.picture === 'string'
          ? metadata.picture
          : null,
  };
}

function requireSupabase() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured. Check the VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY values in your local .env file.');
  }
  return supabase;
}

export async function startDiscordOAuth(): Promise<void> {
  const client = requireSupabase();
  const { data, error } = await client.auth.signInWithOAuth({
    provider: 'discord',
    options: {
      redirectTo: 'kitawatch://auth?provider=discord',
      scopes: 'identify',
      skipBrowserRedirect: true,
    },
  });

  if (error) throw error;
  if (!data.url) throw new Error('Supabase did not return a Discord authorization URL.');
  await openUrl(data.url);
}

export async function completeDiscordOAuth(rawUrl: string): Promise<boolean> {
  const callback = parseDiscordAuthCallback(rawUrl);
  if (!callback) return false;

  const client = requireSupabase();
  const { error } = await client.auth.exchangeCodeForSession(callback.code);
  if (error) throw error;
  return true;
}

export async function getDiscordIdentity(): Promise<DiscordIdentity | null> {
  const client = requireSupabase();
  const { data, error } = await client.auth.getUser();
  if (error) {
    // No active session is normal before the user connects Discord.
    if (/session|auth session missing/i.test(error.message)) return null;
    throw error;
  }
  return data.user ? discordIdentityFromUser(data.user) : null;
}

export async function disconnectDiscord(): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.auth.signOut();
  if (error) throw error;
}
