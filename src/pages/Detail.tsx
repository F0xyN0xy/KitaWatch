import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Play, Plus, Check, Star, ListChecks } from 'lucide-react';
import PageContainer from '@/components/layout/PageContainer';
import AnimeRow from '@/components/anime/AnimeRow';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Skeleton from '@/components/ui/Skeleton';
import ErrorState from '@/components/ui/ErrorState';
import { api } from '@/services/api';
import { anilist } from '@/services/anilist';
import { fetchAnimeInfo } from '@/services/info';
import { useApi } from '@/hooks/useApi';
import { useAnimeStore } from '@/stores/animeStore';
import { useAuthStore } from '@/stores/authStore';
import { useHistoryStore } from '@/stores/historyStore';
import type { AnimeSummary, EpisodeSummary } from '@/types';

// Race local Kuhi against AniList in parallel — first success wins
// (serial fallback made the page sit silent for up to ~50s on failures).
const fetchInfo = fetchAnimeInfo;

/** When every provider's episode list fails, fall back to AniList's episode
 *  count so playback can still be attempted by number (extract works by
 *  anilist ID + episode number alone). Thumbnails fall back to the cover. */
function fallbackEpisodes(
  total: number | undefined,
  cover: string | undefined,
): EpisodeSummary[] {
  if (!total || total <= 0 || total > 500) return [];
  return Array.from({ length: total }, (_, i) => ({
    number: i + 1,
    thumbnail: cover,
  }));
}

/** Popover for adding the anime to any of the user's custom lists. */
function ListPicker({ anime }: { anime: AnimeSummary }) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const customLists = useAnimeStore((s) => s.customLists);
  const createList = useAnimeStore((s) => s.createList);
  const addToList = useAnimeStore((s) => s.addToList);
  const removeFromList = useAnimeStore((s) => s.removeFromList);
  const isInList = useAnimeStore((s) => s.isInList);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const inCount = customLists.filter((l) => isInList(l.id, anime.id)).length;

  return (
    <div ref={wrapRef} className="relative">
      <Button variant="outline" onClick={() => setOpen((v) => !v)}>
        <ListChecks className="h-4 w-4" />
        Lists{inCount > 0 && <span className="text-accent-300"> · {inCount}</span>}
      </Button>
      {open && (
        <div className="absolute left-0 top-full z-40 mt-2 w-64 rounded-xl bg-ink-850 p-2 shadow-2xl ring-1 ring-white/10">
          {customLists.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-zinc-500">
              No custom lists yet — create one below.
            </p>
          )}
          <div className="max-h-56 overflow-y-auto">
            {customLists.map((l) => {
              const inList = isInList(l.id, anime.id);
              return (
                <button
                  key={l.id}
                  onClick={() =>
                    inList ? removeFromList(l.id, anime.id) : addToList(l.id, anime)
                  }
                  className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-sm text-zinc-300 transition hover:bg-ink-800 hover:text-white"
                >
                  <span className="min-w-0 truncate">{l.name}</span>
                  <span className="flex items-center gap-2 text-xs text-zinc-500">
                    {l.anime.length}
                    {inList && <Check className="h-3.5 w-3.5 text-emerald-400" />}
                  </span>
                </button>
              );
            })}
          </div>
          <form
            className="mt-1 flex gap-1.5 border-t border-white/5 pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = newName.trim();
              if (!name) return;
              const id = createList(name);
              addToList(id, anime);
              setNewName('');
            }}
          >
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New list name…"
              className="min-w-0 flex-1 rounded-lg bg-ink-800 px-2.5 py-1.5 text-sm text-zinc-200 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-accent-500/60"
            />
            <button
              type="submit"
              className="rounded-lg bg-accent-600 px-2.5 text-sm text-white transition hover:bg-accent-500"
              title="Create list and add"
            >
              <Plus className="h-4 w-4" />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

export default function Detail() {
  const { id } = useParams<{ id: string }>();
  const info = useApi(() => fetchInfo(id!), [id]);
  const { favorites, toggleFavorite } = useAnimeStore();
  // Latest watched episode — the Play button resumes instead of restarting.
  const resumeEpisode = useHistoryStore((s) =>
    s.entries.find((x) => x.animeId === Number(id))?.episode,
  );

  const handleToggleFavorite = (anime: AnimeSummary) => {
    toggleFavorite(anime);
    const token = useAuthStore.getState().accessToken;
    if (token) {
      anilist
        .toggleFavorite(token, anime.id)
        .catch((e) => console.error('[kitawatch] AniList sync failed:', e));
    }
  };

  if (info.error && !info.data) {
    return (
      <PageContainer>
        <ErrorState
          title="Couldn't load this anime"
          message={info.error}
          onRetry={info.reload}
        />
      </PageContainer>
    );
  }

  const a = info.data;
  const favorite = a ? favorites.some((f) => f.id === a.id) : false;
  // Episode grid comes from AniList's official count — always reliable.
  const shownEpisodes: EpisodeSummary[] = info.loading
    ? []
    : fallbackEpisodes(a?.totalEpisodes, a?.cover);

  // AniList-direct recommendations (covers guaranteed); Kuhi as fallback
  const recommendations = useApi<AnimeSummary[]>(
    () =>
      id
        ? anilist
            .recommendations(id)
            .catch(() => api.recommendations(id, 1).then((r) => r.results))
        : Promise.resolve([]),
    [id],
  );

  // Franchise seasons/parts — sequel, prequel, side story etc. (AniList-direct)
  const relations = useApi(
    () => (id ? anilist.related(id).catch(() => []) : Promise.resolve([])),
    [id],
  );

  return (
    <PageContainer className="!space-y-0 !p-0">
      {/* Banner */}
      <div className="relative h-72 overflow-hidden">
        {info.loading ? (
          <Skeleton className="h-full rounded-none" />
        ) : (
          <>
            {a?.banner || a?.cover ? (
              <img
                src={a?.banner ?? a?.cover}
                alt=""
                className="h-full w-full object-cover object-center"
              />
            ) : (
              <div className="h-full bg-ink-800" />
            )}
            <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/50 to-transparent" />
          </>
        )}
      </div>

      <div className="space-y-8 px-6 pb-6">
        {/* Header */}
        <div className="-mt-20 flex flex-col gap-6 sm:flex-row">
          {info.loading ? (
            <Skeleton className="aspect-[2/3] w-40 rounded-xl" />
          ) : (
            <img
              src={a?.cover ?? a?.banner}
              alt={a?.title}
              className="aspect-[2/3] w-40 rounded-xl object-cover shadow-2xl ring-1 ring-white/10"
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col justify-end pt-20 sm:pt-0">
            {info.loading ? (
              <Skeleton className="h-9 w-72" />
            ) : (
              <h1 className="text-3xl font-bold text-white">{a?.title}</h1>
            )}
            {!info.loading && a && (
              <>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {a.rating != null && typeof a.rating === 'number' && (
                    <Badge variant="rating">
                      <Star className="h-3 w-3 fill-current" />
                      {a.rating.toFixed(1)}
                    </Badge>
                  )}
                  {a.status && <Badge variant="neutral">{a.status}</Badge>}
                  {a.type && <Badge variant="neutral">{a.type}</Badge>}
                  {a.year && <Badge variant="neutral">{a.year}</Badge>}
                  {(a.subCount ?? 0) > 0 && <Badge variant="sub">Sub</Badge>}
                  {(a.dubCount ?? 0) > 0 && <Badge variant="dub">Dub</Badge>}
                </div>
                {a.genres && a.genres.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {a.genres.map((g) => (
                      <span
                        key={g}
                        className="rounded-full bg-ink-800 px-3 py-1 text-xs text-zinc-400 ring-1 ring-white/10"
                      >
                        {g}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-4 flex gap-3">
                  <Link to={`/watch/${a.id}/${resumeEpisode ?? 1}`}>
                    <Button>
                      <Play className="h-4 w-4 fill-current" />
                      {resumeEpisode && resumeEpisode > 1 ? `Resume E${resumeEpisode}` : 'Play'}
                    </Button>
                  </Link>
                  <Button
                    variant="outline"
                    onClick={() => handleToggleFavorite(a)}
                  >
                    {favorite ? (
                      <>
                        <Check className="h-4 w-4 text-emerald-400" /> Favorites
                      </>
                    ) : (
                      <>
                        <Plus className="h-4 w-4" /> Add to Favorites
                      </>
                    )}
                  </Button>
                  <ListPicker anime={a} />
                </div>
              </>
            )}
          </div>
        </div>

        {/* Synopsis */}
        {!info.loading && a?.synopsis && (
          <section>
            <h2 className="mb-2 text-lg font-semibold text-white">Synopsis</h2>
            <p className="max-w-3xl text-sm leading-relaxed text-zinc-400">
              {a.synopsis}
            </p>
          </section>
        )}

        {/* Episodes */}
        <section>
          <h2 className="mb-4 text-lg font-semibold text-white">
            Episodes
            {shownEpisodes.length > 0 && (
              <span className="ml-2 text-sm font-normal text-zinc-500">
                ({shownEpisodes.length})
              </span>
            )}
          </h2>
          {info.loading && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-28" />
              ))}
            </div>
          )}
          {!info.loading && shownEpisodes.length === 0 && (
            <p className="py-8 text-sm text-zinc-500">
              No episodes found — providers may not carry this title yet.
            </p>
          )}
          {!info.loading && shownEpisodes.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {shownEpisodes.map((ep) => (
                <Link
                  key={ep.number}
                  to={`/watch/${id}/${ep.number}`}
                  className="group overflow-hidden rounded-xl bg-ink-850 ring-1 ring-white/5 transition hover:ring-accent-500/60"
                >
                  <div className="aspect-video overflow-hidden bg-ink-800">
                    {ep.thumbnail && (
                      <img
                        src={ep.thumbnail}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      />
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="text-xs font-semibold text-zinc-200">
                      Episode {ep.number}
                    </p>
                    {ep.title && (
                      <p className="mt-0.5 line-clamp-1 text-[11px] text-zinc-500">
                        {ep.title}
                      </p>
                    )}
                    <div className="mt-1 flex gap-1">
                      {ep.hasSub && <Badge variant="sub">Sub</Badge>}
                      {ep.hasDub && <Badge variant="dub">Dub</Badge>}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Seasons & Related — click through to other parts of the franchise */}
        {relations.data && relations.data.length > 0 && (
          <section>
            <h2 className="mb-4 text-lg font-semibold text-white">Seasons &amp; Related</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
              {relations.data.map(({ relation, anime: r }) => (
                <Link
                  key={`${r.id}-${relation}`}
                  to={`/anime/${r.id}`}
                  className="group overflow-hidden rounded-xl bg-ink-850 ring-1 ring-white/5 transition hover:ring-accent-500/60"
                >
                  <div className="aspect-[2/3] overflow-hidden bg-ink-800">
                    {r.cover ? (
                      <img
                        src={r.cover}
                        alt={r.title}
                        loading="lazy"
                        className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center text-xs text-zinc-600">
                        No cover
                      </div>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className="line-clamp-2 text-xs font-semibold text-zinc-200">
                      {r.title}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <Badge variant="accent">{relation}</Badge>
                      {r.type && <Badge variant="neutral">{r.type}</Badge>}
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        )}

        {/* Recommendations (AniList-direct — covers guaranteed) */}
        {recommendations.data && recommendations.data.length > 0 && (
          <AnimeRow title="Recommendations" items={recommendations.data} />
        )}
      </div>
    </PageContainer>
  );
}