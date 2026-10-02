import { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Clock, Search, UserRound, X, Bell, Tv, RefreshCw } from 'lucide-react';
import { useDebounce } from '@/hooks/useDebounce';
import { useRecentSearches } from '@/hooks/useRecentSearches';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { anilist } from '@/services/anilist';
import { fetchNotifications, type AniNotification } from '@/services/anilistSync';
import Badge from '@/components/ui/Badge';
import type { AnimeSummary } from '@/types';

export default function Header() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [value, setValue] = useState(searchParams.get('q') ?? '');
  const debounced = useDebounce(value, 200);
  const { recents, add, clear } = useRecentSearches();
  const { viewer, accessToken } = useAuthStore();

  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<AnimeSummary[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Notification dropdown state
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifications, setNotifications] = useState<AniNotification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [hasUnread, setHasUnread] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  // Only auto-navigate when the CHANGE came from this input — a pending
  // debounce must never yank the user back to /browse after they navigated
  // to Settings etc.
  const dirty = useRef(false);

  // Debounced autocomplete against AniList (fast), Kuhi as fallback
  useEffect(() => {
    const q = debounced.trim();
    if (q.length < 2) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    anilist
      .search(q)
      .catch(() => api.suggestions(q))
      .then((list) => {
        if (cancelled) return;
        setSuggestions(list.filter((s) => s?.id && s?.title).slice(0, 7));
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  // Live search — ONLY for edits made in this input
  useEffect(() => {
    if (!dirty.current) return;
    const q = debounced.trim();
    if (q.length >= 2) navigate(`/browse?q=${encodeURIComponent(q)}`);
    else if (q.length === 0) navigate('/browse');
  }, [debounced, navigate]);

  // External navigation (Settings click etc.): disarm the pending search
  useEffect(() => {
    dirty.current = false;
  }, [searchParams]);

  // Close on outside click
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Fetch AniList notifications for the bell dropdown
  const fetchNotifs = useCallback(async () => {
    if (!accessToken) return;
    setNotifLoading(true);
    try {
      const notifs = await fetchNotifications(accessToken, 20);
      setNotifications(notifs);
      // Blue dot: show if there are any notifications newer than last seen
      const lastSeen = Number(localStorage.getItem('kitawatch-notif-seen') ?? 0);
      const latest = notifs[0]?.createdAt ?? 0;
      setHasUnread(latest > lastSeen);
    } catch {
      // silently fail — dropdown just shows empty
    } finally {
      setNotifLoading(false);
    }
  }, [accessToken]);

  // Poll for notifications every 5 minutes when logged in
  useEffect(() => {
    if (!accessToken) return;
    fetchNotifs();
    const interval = setInterval(fetchNotifs, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [accessToken, fetchNotifs]);

  // Mark as read when dropdown opens
  useEffect(() => {
    if (notifOpen && notifications.length > 0) {
      const latest = notifications[0]?.createdAt ?? 0;
      localStorage.setItem('kitawatch-notif-seen', String(latest));
      setHasUnread(false);
    }
  }, [notifOpen, notifications]);

  const go = (s: AnimeSummary) => {
    add(s.title);
    dirty.current = false;
    setOpen(false);
    navigate(`/anime/${s.id}`);
  };

  const searchFor = (q: string) => {
    add(q);
    dirty.current = true;
    setValue(q);
    setOpen(false);
    navigate(`/browse?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <header className="z-20 flex h-16 shrink-0 items-center gap-4 border-b border-white/5 bg-ink-950/80 px-6 backdrop-blur">
      <div ref={wrapRef} className="relative w-full max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
        <input
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            dirty.current = true;
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') searchFor(value);
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder="Search anime..."
          className="w-full rounded-full bg-ink-850 py-2 pl-9 pr-4 text-sm text-zinc-200 ring-1 ring-white/10 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-accent-500/60"
        />
        {value && (
          <button
            onClick={() => {
              setValue('');
              dirty.current = false;
              navigate('/browse');
            }}
            aria-label="Clear search"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1 text-zinc-500 hover:text-zinc-200"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Autocomplete / recent searches dropdown */}
        {open && (
          <div className="absolute left-0 right-0 top-full z-50 mt-2 overflow-hidden rounded-xl bg-ink-850 shadow-2xl ring-1 ring-white/10">
            {suggestions.length > 0 ? (
              <ul className="max-h-80 overflow-y-auto p-1.5">
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        go(s);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-zinc-300 transition hover:bg-ink-800 hover:text-white"
                    >
                      <img
                        src={s.cover}
                        alt=""
                        className="h-9 w-6 rounded object-cover"
                        onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                      />
                      <span className="min-w-0 flex-1 truncate">{s.title}</span>
                      {s.type && <Badge variant="neutral">{s.type}</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              recents.length > 0 && (
                <div className="p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                      <Clock className="h-3 w-3" /> Recent searches
                    </span>
                    <button
                      onMouseDown={(e) => {
                        e.preventDefault();
                        clear();
                      }}
                      className="text-[11px] text-zinc-500 hover:text-zinc-300"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {recents.map((r) => (
                      <button
                        key={r}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          searchFor(r);
                        }}
                        className="rounded-full bg-ink-800 px-3 py-1 text-xs text-zinc-300 ring-1 ring-white/10 transition hover:text-white hover:ring-accent-500/50"
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* AniList account + notification bell */}
      <div className="ml-auto flex items-center gap-2">
        {/* Notification bell */}
        <div ref={notifRef} className="relative">
          <button
            onClick={() => setNotifOpen((v) => !v)}
            title="Notifications"
            className={`relative flex h-8 w-8 items-center justify-center rounded-full transition ${
              notifOpen
                ? 'bg-ink-850 text-accent-400'
                : 'text-zinc-400 hover:bg-ink-850 hover:text-accent-400'
            }`}
          >
            <Bell className="h-4 w-4" />
            {hasUnread && (
              <span className="absolute right-0.5 top-0.5 h-2 w-2 rounded-full bg-blue-500 ring-2 ring-ink-950" />
            )}
          </button>

          {notifOpen && (
            <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl bg-ink-850 shadow-2xl ring-1 ring-white/10">
              <div className="flex items-center justify-between border-b border-white/5 px-4 py-2.5">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
                  Notifications
                </span>
                <button
                  onClick={fetchNotifs}
                  disabled={notifLoading}
                  className="text-zinc-500 hover:text-accent-400 transition"
                  title="Refresh"
                >
                  <RefreshCw className={`h-3 w-3 ${notifLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>

              {!accessToken ? (
                <div className="p-4 text-center">
                  <p className="text-xs text-zinc-500">Log in with AniList to see notifications.</p>
                  <Link
                    to="/settings"
                    onClick={() => setNotifOpen(false)}
                    className="mt-2 inline-block text-xs text-accent-400 hover:underline"
                  >
                    Go to Settings
                  </Link>
                </div>
              ) : notifLoading && notifications.length === 0 ? (
                <div className="p-4 text-center text-xs text-zinc-500">Loading…</div>
              ) : notifications.length === 0 ? (
                <div className="p-4 text-center text-xs text-zinc-500">No notifications.</div>
              ) : (
                <div className="max-h-96 overflow-y-auto">
                  {notifications.map((notif) => {
                    const timeAgo = notif.createdAt
                      ? (() => {
                          const diff = Date.now() / 1000 - notif.createdAt;
                          if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
                          if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
                          return `${Math.floor(diff / 86400)}d ago`;
                        })()
                      : '';
                    const mediaTitle =
                      notif.media?.title?.english ?? notif.media?.title?.romaji ?? '';

                    let icon: React.ReactNode;
                    let text: string;
                    let onClick: (() => void) | undefined;

                    switch (notif.type) {
                      case 'AIRING':
                        icon = notif.media?.coverImage?.large ? (
                          <img
                            src={notif.media.coverImage.large}
                            alt=""
                            className="h-9 w-6 rounded object-cover shrink-0"
                            onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                          />
                        ) : (
                          <Tv className="h-4 w-4 text-accent-400 shrink-0" />
                        );
                        text = `Episode ${notif.episode} of ${mediaTitle} just aired`;
                        onClick = () => {
                          setNotifOpen(false);
                          navigate(`/anime/${notif.animeId}`);
                        };
                        break;
                      case 'FOLLOWING':
                        icon = notif.user?.avatar?.large ? (
                          <img
                            src={notif.user.avatar.large}
                            alt=""
                            className="h-6 w-6 rounded-full object-cover shrink-0"
                          />
                        ) : (
                          <UserRound className="h-4 w-4 text-zinc-500 shrink-0" />
                        );
                        text = `${notif.user?.name ?? 'Someone'} started following you`;
                        break;
                      case 'ACTIVITY_LIKE':
                        icon = notif.user?.avatar?.large ? (
                          <img
                            src={notif.user.avatar.large}
                            alt=""
                            className="h-6 w-6 rounded-full object-cover shrink-0"
                          />
                        ) : (
                          <UserRound className="h-4 w-4 text-zinc-500 shrink-0" />
                        );
                        text = `${notif.user?.name ?? 'Someone'} liked your activity`;
                        break;
                      case 'ACTIVITY_REPLY':
                        icon = notif.user?.avatar?.large ? (
                          <img
                            src={notif.user.avatar.large}
                            alt=""
                            className="h-6 w-6 rounded-full object-cover shrink-0"
                          />
                        ) : (
                          <UserRound className="h-4 w-4 text-zinc-500 shrink-0" />
                        );
                        text = `${notif.user?.name ?? 'Someone'} replied to your activity`;
                        break;
                      case 'ACTIVITY_MENTION':
                        icon = notif.user?.avatar?.large ? (
                          <img
                            src={notif.user.avatar.large}
                            alt=""
                            className="h-6 w-6 rounded-full object-cover shrink-0"
                          />
                        ) : (
                          <UserRound className="h-4 w-4 text-zinc-500 shrink-0" />
                        );
                        text = `${notif.user?.name ?? 'Someone'} mentioned you`;
                        break;
                      case 'RELATED_MEDIA_ADDITION':
                        icon = notif.media?.coverImage?.large ? (
                          <img
                            src={notif.media.coverImage.large}
                            alt=""
                            className="h-9 w-6 rounded object-cover shrink-0"
                          />
                        ) : (
                          <Tv className="h-4 w-4 text-accent-400 shrink-0" />
                        );
                        text = `New related media added: ${mediaTitle}`;
                        onClick = () => {
                          setNotifOpen(false);
                          if (notif.media?.id) navigate(`/anime/${notif.media.id}`);
                        };
                        break;
                      case 'MEDIA_DATA_CHANGE':
                        icon = <Tv className="h-4 w-4 text-yellow-500 shrink-0" />;
                        text = `Data changed for ${mediaTitle}`;
                        onClick = () => {
                          setNotifOpen(false);
                          if (notif.media?.id) navigate(`/anime/${notif.media.id}`);
                        };
                        break;
                      case 'MEDIA_MERGE':
                        icon = <Tv className="h-4 w-4 text-orange-500 shrink-0" />;
                        text = `Entries merged for ${mediaTitle}`;
                        break;
                      case 'MEDIA_DELETION':
                        icon = <Tv className="h-4 w-4 text-red-500 shrink-0" />;
                        text = `An entry was deleted from your list`;
                        break;
                      default:
                        icon = <Bell className="h-4 w-4 text-zinc-500 shrink-0" />;
                        text = notif.type ?? 'New notification';
                    }

                    return (
                      <button
                        key={notif.id}
                        onClick={onClick}
                        disabled={!onClick}
                        className={`flex w-full items-start gap-2.5 px-4 py-2.5 text-left transition hover:bg-ink-800 ${
                          !onClick ? 'cursor-default' : ''
                        }`}
                      >
                        <span className="mt-0.5 shrink-0">{icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-xs text-zinc-300">{text}</span>
                          <span className="mt-0.5 block text-[9px] text-zinc-600">{timeAgo}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {viewer && accessToken ? (
          <Link
            to="/settings"
            title="AniList account"
            className="flex items-center gap-2 rounded-full bg-ink-850 py-1 pl-1 pr-3 ring-1 ring-white/10 transition hover:ring-accent-500/50"
          >
            {viewer.avatar ? (
              <img src={viewer.avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
            ) : (
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-600 text-[10px] font-bold text-white">
                {viewer.name.slice(0, 2).toUpperCase()}
              </span>
            )}
            <span className="text-xs text-zinc-300">{viewer.name}</span>
          </Link>
        ) : (
          <Link
            to="/settings"
            className="flex items-center gap-2 rounded-full bg-ink-850 px-3 py-1.5 text-xs text-zinc-300 ring-1 ring-white/10 transition hover:text-white hover:ring-accent-500/50"
          >
            <UserRound className="h-3.5 w-3.5 text-accent-400" />
            Login with AniList
          </Link>
        )}
      </div>
    </header>
  );
}
