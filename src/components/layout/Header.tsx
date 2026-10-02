import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Clock, Search, UserRound, X, Bell } from 'lucide-react';
import { useDebounce } from '@/hooks/useDebounce';
import { useRecentSearches } from '@/hooks/useRecentSearches';
import { useAuthStore } from '@/stores/authStore';
import { api } from '@/services/api';
import { anilist } from '@/services/anilist';
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
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

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

      {/* Notification / Updates icon — LEFT of profile */}
      <Link to="/settings" title="Updates & Lists" className="mr-2 flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 hover:bg-ink-850 hover:text-accent-400 transition">
        <Bell className="h-4 w-4" />
      </Link>

      {/* AniList account */}
      <div className="ml-auto">
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
