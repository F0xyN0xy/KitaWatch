import { useEffect, useState } from 'react';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import {
  disconnectDiscord,
  discordIdentityFromUser,
  startDiscordOAuth,
  type DiscordIdentity,
} from '@/services/discordAuth';
import Button from '@/components/ui/Button';

export default function DiscordAccount() {
  const [identity, setIdentity] = useState<DiscordIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    if (!supabase || !isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    let active = true;
    void supabase.auth.getSession().then(({ data, error }) => {
      if (!active) return;
      if (error) setNote(error.message);
      setIdentity(data.session?.user ? discordIdentityFromUser(data.session.user) : null);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!active) return;
      setIdentity(session?.user ? discordIdentityFromUser(session.user) : null);
      setNote('');
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);

  const connect = async () => {
    setBusy(true);
    setNote('');
    try {
      await startDiscordOAuth();
      setNote('Discord opened in your browser. Approve the request to return to KitaWatch.');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not start Discord login.');
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setNote('');
    try {
      await disconnectDiscord();
      setIdentity(null);
      setNote('Discord account disconnected.');
    } catch (error) {
      setNote(error instanceof Error ? error.message : 'Could not disconnect Discord.');
    } finally {
      setBusy(false);
    }
  };

  if (!isSupabaseConfigured || !supabase) {
    return (
      <section className="rounded-2xl bg-ink-900 p-5 ring-1 ring-white/5">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-zinc-500">Discord Account</h2>
        <p className="text-sm text-zinc-400">
          Discord login is not configured in this build. Add the Supabase URL and publishable key to your local .env file.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl bg-ink-900 p-5 ring-1 ring-white/5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-zinc-500">Discord Account</h2>
      {loading ? (
        <p className="text-sm text-zinc-400">Checking Discord connection…</p>
      ) : identity ? (
        <div className="flex items-center gap-3">
          {identity.avatarUrl ? (
            <img src={identity.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover ring-2 ring-accent-500/40" />
          ) : (
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-600 text-sm font-bold text-white">
              {identity.displayName.slice(0, 2).toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-white">{identity.displayName}</p>
            <p className="text-xs text-zinc-500">Connected for leaderboard features</p>
          </div>
          <Button variant="outline" size="sm" onClick={disconnect} disabled={busy}>
            {busy ? 'Working…' : 'Disconnect'}
          </Button>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-zinc-400">
            Connect Discord to use a shared KitaWatch profile and appear on the community leaderboard. This does not change your AniList login or Rich Presence.
          </p>
          <Button onClick={connect} disabled={busy}>
            {busy ? 'Opening Discord…' : 'Connect Discord'}
          </Button>
        </>
      )}
      {note && <p role="status" className="mt-3 text-xs text-zinc-400">{note}</p>}
    </section>
  );
}
