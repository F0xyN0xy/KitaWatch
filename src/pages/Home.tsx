import { useNavigate } from 'react-router-dom';
import { Play } from 'lucide-react';
import PageContainer from '@/components/layout/PageContainer';
import AnimeRow from '@/components/anime/AnimeRow';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Skeleton from '@/components/ui/Skeleton';
import ErrorState from '@/components/ui/ErrorState';
import { api } from '@/services/api';
import { anilist } from '@/services/anilist';
import { useHistoryStore } from '@/stores/historyStore';
import { useApi } from '@/hooks/useApi';
import type { SpotlightAnime, AnimeSummary } from '@/types';

function Hero({ anime }: { anime: SpotlightAnime }) {
  const navigate = useNavigate();
  return (
    <div className="relative h-[420px] overflow-hidden rounded-2xl ring-1 ring-white/5">
      {anime.banner || anime.cover ? (
        <img
          src={anime.banner ?? anime.cover}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bg-ink-800" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-ink-950 via-ink-950/40 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-ink-950/80 via-transparent to-transparent" />
      <div className="absolute bottom-0 left-0 max-w-2xl p-8">
        <Badge variant="accent">#1 Spotlight</Badge>
        <h1 className="mt-3 text-4xl font-bold text-white drop-shadow-lg">
          {anime.title}
        </h1>
        {anime.description && (
          <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-zinc-300">
            {anime.description}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          <Button onClick={() => navigate(`/watch/${anime.id}/1`)}>
            <Play className="h-4 w-4 fill-current" /> Watch Now
          </Button>
          <Button variant="outline" onClick={() => navigate(`/anime/${anime.id}`)}>
            Details
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const spotlight = useApi(api.spotlight, [], { retries: 8 });
  const trending = useApi(() => api.trending(1, 14), []);
  const popular = useApi(() => api.popular(1, 14), []);
  const recent = useApi(() => api.recent(1, 14), []);
  const historyEntries = useHistoryStore((s) => s.entries);
  const continueWatching = historyEntries.slice(0, 14).map((h) => ({
    id: h.animeId,
    title: h.title,
    cover: h.cover,
  }));
  // #7: watched fraction per anime for the Continue Watching progress bars.
  const progressById = new Map<number, number | undefined>(
    historyEntries.map((h) => [
      h.animeId,
      h.duration ? (h.position ?? 0) / h.duration : undefined,
    ]),
  );

  const latestWatch = historyEntries[0];
  // Async fetcher — NOT a promise chain. a .catch() on a method call can
  // never catch a synchronous TypeError ("x is not a function"); try/catch
  // inside an async function does, and still falls back to the Kuhi API.
  const fetchRecommendations = async (): Promise<AnimeSummary[]> => {
    if (!latestWatch) return [];
    try {
      return await anilist.recommendations(latestWatch.animeId);
    } catch {
      return api
        .recommendations(latestWatch.animeId, 1)
        .then((p) => p.results);
    }
  };
  const recommendations = useApi<AnimeSummary[]>(fetchRecommendations, [
    latestWatch?.animeId,
  ]);

  return (
    <PageContainer>
      {spotlight.error && !spotlight.data ? (
        <ErrorState
          title="Couldn't reach the API"
          message={`${spotlight.error} The app starts its own backends — give them a few seconds and retry.`}
          onRetry={spotlight.reload}
        />
      ) : spotlight.loading ? (
        <Skeleton className="h-[420px] rounded-2xl" />
      ) : spotlight.data?.[0] ? (
        <Hero anime={spotlight.data[0]} />
      ) : null}

      {continueWatching.length > 0 && (
        <AnimeRow
          title="Continue Watching"
          items={continueWatching}
          getProgress={(a) => progressById.get(a.id)}
        />
      )}

      {latestWatch && recommendations.data && recommendations.data.length > 0 && (
        <AnimeRow
          title={`Because you watched ${latestWatch.title}`}
          items={recommendations.data}
          loading={recommendations.loading}
        />
      )}

      <AnimeRow title="Trending Now" items={trending.data?.results} loading={trending.loading} />
      <AnimeRow title="Popular This Season" items={popular.data?.results} loading={popular.loading} />
      <AnimeRow title="Recently Aired" items={recent.data?.results} loading={recent.loading} />
    </PageContainer>
  );
}