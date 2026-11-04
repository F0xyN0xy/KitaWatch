import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  Eye,
  EyeOff,
  Medal,
  RefreshCw,
  ShieldCheck,
  Trophy,
  UserRound,
} from 'lucide-react';
import PageContainer from '@/components/layout/PageContainer';
import Button from '@/components/ui/Button';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import { ensureGuestSession } from '@/services/guestSession';

type LeaderboardPeriod = 'weekly' | 'monthly' | 'all_time';

interface LeaderboardEntry {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  episode_count: number;
  rank: number;
}

const PERIODS: { value: LeaderboardPeriod; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'all_time', label: 'All time' },
];

function formatEpisodes(count: number) {
  return `${count} ${count === 1 ? 'episode' : 'episodes'}`;
}

function Avatar({ name, url }: { name: string; url: string | null }) {
  if (url) {
    return <img src={url} alt="" className="h-10 w-10 rounded-full bg-ink-700 object-cover" />;
  }

  return (
    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-700 text-zinc-300">
      <UserRound className="h-5 w-5" />
    </div>
  );
}

export default function Leaderboard() {
  const [period, setPeriod] = useState<LeaderboardPeriod>('weekly');
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('KitaWatch user');
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [leaderboardVisible, setLeaderboardVisible] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingVisibility, setSavingVisibility] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  const loadLeaderboard = useCallback(async (showRefresh = false) => {
    if (!isSupabaseConfigured || !supabase) {
      setError('Leaderboard is unavailable because Supabase is not configured in this build.');
      setLoading(false);
      setRefreshing(false);
      return;
    }

    if (showRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    setProfileError(null);

    try {
      await ensureGuestSession();

      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!authData.user) throw new Error('No KitaWatch account is available yet.');

      const user = authData.user;
      setUserId(user.id);
      setIsAnonymous(Boolean(user.is_anonymous));

      const [{ data: profile, error: readProfileError }, { data: ranking, error: rankingError }] =
        await Promise.all([
          supabase
            .from('profiles')
            .select('display_name, leaderboard_visible')
            .eq('id', user.id)
            .maybeSingle(),
          supabase.rpc('get_leaderboard', { p_period: period, p_limit: 50 }),
        ]);

      if (readProfileError) throw readProfileError;
      if (rankingError) throw rankingError;

      if (profile) {
        setDisplayName(profile.display_name || 'KitaWatch user');
        setLeaderboardVisible(Boolean(profile.leaderboard_visible));
      } else {
        setProfileError('Your profile is still being created. Refresh in a moment to manage leaderboard visibility.');
      }

      setEntries((ranking ?? []) as LeaderboardEntry[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Something went wrong while loading the leaderboard.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [period]);

  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);

  const updateVisibility = async (visible: boolean) => {
    if (!supabase || !userId) return;

    setSavingVisibility(true);
    setProfileError(null);
    try {
      const { data, error: updateError } = await supabase
        .from('profiles')
        .update({ leaderboard_visible: visible })
        .eq('id', userId)
        .select('leaderboard_visible')
        .single();

      if (updateError) throw updateError;
      setLeaderboardVisible(Boolean(data.leaderboard_visible));
      // Refresh so an opted-in account appears (or disappears) immediately.
      await loadLeaderboard(true);
    } catch (updateError) {
      setProfileError(updateError instanceof Error ? updateError.message : 'Could not update your leaderboard privacy setting.');
    } finally {
      setSavingVisibility(false);
    }
  };

  const currentUserEntry = entries.find((entry) => entry.user_id === userId);

  return (
    <PageContainer>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-accent-300">
            <Trophy className="h-5 w-5" />
            <span className="text-xs font-semibold uppercase tracking-[0.18em]">Community</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Leaderboard</h1>
          <p className="mt-1 max-w-xl text-sm text-zinc-500">
            See how the KitaWatch community is watching. Only accounts that opt in are listed.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadLeaderboard(true)} disabled={loading || refreshing}>
          <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <section className="rounded-2xl border border-white/10 bg-ink-900 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent-500/10 text-accent-300">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="font-semibold text-zinc-100">Leaderboard privacy</h2>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-zinc-500">
                Your profile is private on the leaderboard by default. Opting in shares your display name and avatar alongside your qualifying episode count.
              </p>
              <p className="mt-2 text-xs text-zinc-400">
                {isAnonymous ? 'You are using a guest account.' : 'You are using your connected KitaWatch account.'}
                {' '}Profile: <span className="font-medium text-zinc-200">{displayName}</span>
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={leaderboardVisible}
            aria-label="Show my profile on the leaderboard"
            onClick={() => void updateVisibility(!leaderboardVisible)}
            disabled={savingVisibility || loading || !userId || Boolean(profileError)}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50 ${leaderboardVisible ? 'bg-accent-600' : 'bg-ink-700'}`}
          >
            <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${leaderboardVisible ? 'translate-x-6' : 'translate-x-1'}`} />
          </button>
        </div>
        {profileError && (
          <p className="mt-3 flex items-start gap-2 text-xs text-amber-300">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {profileError}
          </p>
        )}
        <div className="mt-4 flex items-center gap-2 border-t border-white/5 pt-3 text-[11px] text-zinc-600">
          {leaderboardVisible ? <Eye className="h-3.5 w-3.5 text-emerald-400" /> : <EyeOff className="h-3.5 w-3.5" />}
          {leaderboardVisible
            ? 'Your profile can appear in public leaderboard results.'
            : 'Your profile is hidden from public leaderboard results.'}
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-white">Top watchers</h2>
          <p className="mt-0.5 text-xs text-zinc-500">Based on qualifying completed episodes.</p>
        </div>
        <div className="flex rounded-lg bg-ink-900 p-1 ring-1 ring-white/10">
          {PERIODS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setPeriod(item.value)}
              aria-pressed={period === item.value}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${period === item.value ? 'bg-accent-600/20 text-accent-300' : 'text-zinc-500 hover:text-zinc-200'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
          <p className="flex items-center gap-2 text-sm font-medium text-red-300">
            <AlertCircle className="h-4 w-4" /> Couldn't load the leaderboard
          </p>
          <p className="mt-2 text-xs text-zinc-400">{error}</p>
          <Button className="mt-4" variant="outline" size="sm" onClick={() => void loadLeaderboard(true)}>
            Try again
          </Button>
        </div>
      ) : loading ? (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((item) => (
            <div key={item} className="h-[68px] animate-pulse rounded-xl bg-ink-900" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center rounded-2xl border border-white/5 bg-ink-900/60 px-5 py-14 text-center">
          <Trophy className="h-10 w-10 text-zinc-700" />
          <h3 className="mt-3 font-semibold text-zinc-300">No rankings yet</h3>
          <p className="mt-1 max-w-md text-sm text-zinc-500">
            There are no opted-in accounts with qualifying watched episodes for this period yet. Opt in above and keep watching to take a place.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {entries.map((entry) => {
            const isCurrentUser = entry.user_id === userId;
            return (
              <div
                key={entry.user_id}
                className={`flex items-center gap-3 rounded-xl border px-3 py-3 sm:px-4 ${isCurrentUser ? 'border-accent-500/40 bg-accent-500/5' : 'border-white/5 bg-ink-900/70'}`}
              >
                <div className="flex w-8 shrink-0 justify-center">
                  {entry.rank <= 3 ? (
                    <Medal className={`h-5 w-5 ${entry.rank === 1 ? 'text-amber-300' : entry.rank === 2 ? 'text-zinc-300' : 'text-orange-400'}`} />
                  ) : (
                    <span className="text-sm tabular-nums text-zinc-500">#{entry.rank}</span>
                  )}
                </div>
                <Avatar name={entry.display_name} url={entry.avatar_url} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-100">
                    {entry.display_name || 'KitaWatch user'}
                    {isCurrentUser && <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-accent-300">You</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-zinc-500">{formatEpisodes(Number(entry.episode_count) || 0)}</p>
                </div>
                <span className="text-sm font-semibold tabular-nums text-zinc-300">{Number(entry.episode_count) || 0}</span>
              </div>
            );
          })}
        </div>
      )}

      {currentUserEntry && (
        <p className="text-xs text-zinc-500">
          You are currently ranked <span className="font-semibold text-accent-300">#{currentUserEntry.rank}</span> for this period.
        </p>
      )}
    </PageContainer>
  );
}
