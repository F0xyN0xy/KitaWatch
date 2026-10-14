import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import PageContainer from '@/components/layout/PageContainer';
import AnimeGrid from '@/components/anime/AnimeGrid';
import Skeleton from '@/components/ui/Skeleton';
import ErrorState from '@/components/ui/ErrorState';
import Button from '@/components/ui/Button';
import { api, isAdultSearchIntent } from '@/services/api';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AnimeSummary, FilterSort } from '@/types';

const SORTS = [
  { key: 'trending', label: 'Trending', sort: 'TRENDING_DESC' as FilterSort },
  { key: 'popular', label: 'Popular', sort: 'POPULARITY_DESC' as FilterSort },
  { key: 'recent', label: 'Recent', sort: 'UPDATED_AT_DESC' as FilterSort },
] as const;

type SortKey = (typeof SORTS)[number]['key'];

export default function Browse() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q')?.trim() ?? '';
  const rawSort = searchParams.get('sort');
  const sort: SortKey =
    rawSort === 'popular' || rawSort === 'recent' ? rawSort : 'trending';
  const genre = searchParams.get('genre') ?? '';
  const adultProvidersUnavailable = useSettingsStore((s) => s.adultProvidersUnavailable);
  const blockedAdultIntent =
    adultProvidersUnavailable && isAdultSearchIntent(q || genre);

  const [page, setPage] = useState(1);
  const [items, setItems] = useState<AnimeSummary[]>([]);
  const [hasNext, setHasNext] = useState(false);
  const [genres, setGenres] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const scrollRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    api.genres().then(setGenres).catch(() => setGenres([]));
  }, []);

  useEffect(() => {
    setPage(1);
    setItems([]);
  }, [q, sort, genre]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (blockedAdultIntent) {
      setItems([]);
      setHasNext(false);
      setLoading(false);
      setLoadingMore(false);
      return () => {
        cancelled = true;
      };
    }
    if (page === 1) setLoading(true);
    else setLoadingMore(true);

    const sortCfg = SORTS.find((s) => s.key === sort)!;
    const fetcher = q
      ? api.search(q, page)
      : genre
        ? api.filter({ genre, sort: sortCfg.sort, page })
        : sort === 'popular'
          ? api.popular(page)
          : sort === 'recent'
            ? api.recent(page)
            : api.trending(page);

    fetcher
      .then((data) => {
        if (cancelled) return;
        setItems((prev) => (page === 1 ? data.results : [...prev, ...data.results]));
        setHasNext(data.hasNextPage);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        setLoadingMore(false);
      });

    return () => {
      cancelled = true;
    };
  }, [q, sort, genre, page, retryKey, blockedAdultIntent]);

  const updateParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, val] of Object.entries(patch)) {
      if (val) next.set(key, val);
      else next.delete(key);
    }
    setSearchParams(next);
    scrollRef.current?.scrollTo({ top: 0 });
  };

  return (
    <PageContainer ref={scrollRef} className="!space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold text-white">
          {q ? (
            <>
              Results for <span className="text-accent-400">&ldquo;{q}&rdquo;</span>
            </>
          ) : sort === 'popular' ? (
            'Popular'
          ) : sort === 'recent' ? (
            'Recently Aired'
          ) : (
            'Trending'
          )}
        </h1>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Sort segments */}
          {!q && (
            <div className="flex rounded-lg bg-ink-850 p-1 ring-1 ring-white/10">
              {SORTS.map((s) => (
                <button
                  key={s.key}
                  onClick={() => updateParams({ sort: s.key === 'trending' ? null : s.key })}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition ${
                    sort === s.key
                      ? 'bg-accent-600 text-white'
                      : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {/* Genre filter (hidden while searching — API has no genre+query combo) */}
          {!q && genres.length > 0 && (
            <select
              value={genre}
              onChange={(e) => updateParams({ genre: e.target.value || null })}
              className="rounded-lg bg-ink-850 px-3 py-2 text-xs text-zinc-300 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-accent-500/60"
            >
              <option value="">All genres</option>
              {genres.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {blockedAdultIntent && (
        <div role="status" className="rounded-xl bg-ink-900 p-5 ring-1 ring-white/10">
          <h2 className="text-sm font-semibold text-white">
            Adult-content providers temporarily unavailable
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Sorry, we're working on these providers. They are unavailable right now.
            Please try again later.
          </p>
        </div>
      )}

      {!blockedAdultIntent && loading && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3]" />
          ))}
        </div>
      )}

      {!blockedAdultIntent && !loading && error && (
        <ErrorState
          title="Couldn't load anime"
          message={error}
          onRetry={() => setRetryKey((k) => k + 1)}
        />
      )}

      {!blockedAdultIntent && !loading && !error && (
        <>
          {items.length === 0 ? (
            <p className="py-16 text-center text-sm text-zinc-500">
              {genre ? `Nothing found in ${genre}.` : 'No results found.'}
            </p>
          ) : (
            <AnimeGrid items={items} scrollElement={scrollRef} />
          )}
          {items.length > 0 && hasNext && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                onClick={() => setPage((p) => p + 1)}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading...' : 'Load more'}
              </Button>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
