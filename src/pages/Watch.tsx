import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Layers } from 'lucide-react';
import PageContainer from '@/components/layout/PageContainer';
import VideoPlayer from '@/components/player/VideoPlayer';
import TorrentPanel from '@/components/player/TorrentPanel';
import ProviderCheck from '@/components/player/ProviderCheck';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Skeleton from '@/components/ui/Skeleton';
import ErrorState from '@/components/ui/ErrorState';
import Disclaimer from '@/components/ui/Disclaimer';
import { resolveStreams, streamUpdates } from '@/services/streamResolver';
import { fetchAnimeInfo } from '@/services/info';
import { useApi } from '@/hooks/useApi';
import { useSettingsStore } from '@/stores/settingsStore';
import { useHistoryStore } from '@/stores/historyStore';
import { setDiscordPresence, clearDiscordPresence } from '@/services/discord';
import type { StreamSource } from '@/types';

// Cached + AniList-first info fetcher: instant on revisits, and roughly
// halves the AniList traffic that was getting the app rate-limited (the old
// version raced api.info and anilist.info in parallel on every page open).
const fetchInfo = fetchAnimeInfo;

/** Identity of a source — survives list re-sorts and background merges. */
const sourceKey = (s: StreamSource) => `${s.server ?? 'src'}|${s.url}`;

export default function Watch() {
  const { id, episode } = useParams<{ id: string; episode: string }>();
  const navigate = useNavigate();
  const epNum = Number(episode) || 1;
  const autoplayNext = useSettingsStore((s) => s.autoplayNext);

  const info = useApi(() => fetchInfo(id!), [id]);
  // Episode strip comes from AniList's official count (same approach as the
  // detail page) — no extra fetch, renders as soon as the cached info lands.
  const epTotal = info.data?.totalEpisodes;
  const episodeList: number[] =
    epTotal && epTotal > 0 && epTotal <= 500
      ? Array.from({ length: epTotal }, (_, i) => i + 1)
      : [];
  const [audio, setAudio] = useState<'sub' | 'dub'>('sub');
  const streams = useApi(
    () => resolveStreams(id!, epNum, audio, info.data?.title),
    [id, epNum, audio, info.data?.title],
  );

  const allSources = streams.data?.streams ?? [];

  // The selection is keyed by SOURCE IDENTITY, not list index: providers
  // merge in the background and probes re-sort the list, which used to
  // yank the playing source out from under the player (the "Anivexa
  // overwrite"). Keyed selection keeps whatever is playing, playing.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // Sources that errored at runtime. Dead sources are never auto-selected
  // and never kill the list — they stay visible (greyed) so nothing
  // mysteriously vanishes when a late provider merges in.
  const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());

  const isDead = (s: StreamSource) => s.verified === false || failedKeys.has(sourceKey(s));
  const chosen = activeKey ? allSources.find((s) => sourceKey(s) === activeKey) : undefined;
  // The chosen source ALWAYS survives: probe verdicts have false negatives
  // (short timeouts, referer-locked hosts), and a playing source must never
  // disappear from under the user when Anivexa & co. merge in late.
  const live = allSources.filter(
    (s) => (chosen && sourceKey(s) === sourceKey(chosen)) || !isDead(s),
  );
  const dead = allSources.filter(
    (s) => !(chosen && sourceKey(s) === sourceKey(chosen)) && isDead(s),
  );
  const activeIndex = chosen ? Math.max(0, live.findIndex((s) => sourceKey(s) === sourceKey(chosen))) : 0;
  const activeSource = live[activeIndex];

  const failActive = () => {
    if (!activeSource) return;
    const key = sourceKey(activeSource);
    setFailedKeys((prev) => new Set(prev).add(key));
  };

  // Late providers merge into the result in the background — reload on their
  // update event so the Sources list grows without a manual refresh.
  const reloadRef = useRef(streams.reload);
  reloadRef.current = streams.reload;
  useEffect(() => {
    const onUpdate = (e: Event) => {
      if ((e as CustomEvent<string>).detail === `${id}|${epNum}|${audio}`) {
        reloadRef.current();
      }
    };
    streamUpdates.addEventListener('update', onUpdate);
    return () => streamUpdates.removeEventListener('update', onUpdate);
  }, [id, epNum, audio]);

  const [torrent, setTorrent] = useState<{ url: string; label: string } | null>(null);

  const resetKey = `${id}|${epNum}|${audio}`;
  const [lastResetKey, setLastResetKey] = useState(resetKey);
  useEffect(() => {
    if (lastResetKey === resetKey) return;
    setLastResetKey(resetKey);
    setActiveKey(null);
    setFailedKeys(new Set());
    setTorrent(null);
  }, [resetKey, lastResetKey]);

  // Record the visit as soon as the anime info is known — NOT gated on
  // sources resolving. The player saves its position into this entry; if
  // the entry didn't exist yet (cached streams resolve before info), those
  // saves were silently dropped and resume-from-position never worked.
  useEffect(() => {
    if (info.data) {
      useHistoryStore.getState().upsert({
        animeId: Number(id),
        episode: epNum,
        title: info.data.title,
        cover: info.data.cover,
      });
    }
  }, [info.data, id, epNum]);

  // Discord activity: "Watching <title>" / "Episode N". Cleared on unmount.
  // Re-sends every 15s to win priority over other RPC clients (e.g. VS Code).
  useEffect(() => {
    if (!info.data?.title) return;
    const update = () => setDiscordPresence(`Watching ${info.data!.title}`, `Episode ${epNum}`);
    update();
    const interval = setInterval(update, 15_000);
    return () => {
      clearInterval(interval);
      clearDiscordPresence();
    };
  }, [info.data?.title, epNum]);

  const totalEpisodes = info.data?.totalEpisodes;
  const hasNext = totalEpisodes == null || epNum < totalEpisodes;

  const httpPlayer = activeSource && (
    <VideoPlayer
      key={sourceKey(activeSource)}
      source={activeSource}
      animeId={id!}
      episodeNumber={epNum}
      hasNextEpisode={hasNext}
      autoplayNext={autoplayNext}
      subtitles={streams.data?.subtitles}
      poster={info.data?.banner ?? info.data?.cover}
      onFatal={() => {
        // Mark the dead source; playback falls through to the next live
        // one. The failed pill greys out instead of the stream vanishing.
        failActive();
      }}
      onEnded={() => navigate(`/watch/${id}/${epNum + 1}`)}
    />
  );

  const torrentSource: StreamSource | null = torrent && {
    type: 'mp4',
    url: torrent.url,
    server: torrent.label,
  };

  const torrentPlayer = torrentSource && (
    <VideoPlayer
      key={`torrent-${torrentSource.url}`}
      source={torrentSource}
      animeId={id!}
      episodeNumber={epNum}
      hasNextEpisode={hasNext}
      autoplayNext={autoplayNext}
      poster={info.data?.banner ?? info.data?.cover}
      onFatal={() => setTorrent(null)}
      onEnded={() => navigate(`/watch/${id}/${epNum + 1}`)}
    />
  );

  const renderPill = (s: StreamSource, isActive: boolean, isDeadPill: boolean) => {
    const key = sourceKey(s);
    return (
      <button
        key={key}
        onClick={() => !isDeadPill && setActiveKey(key)}
        disabled={isDeadPill}
        title={isDeadPill ? 'Unresponsive' : undefined}
        className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs ring-1 transition ${
          isDeadPill
            ? 'cursor-not-allowed bg-ink-900 text-zinc-600 ring-white/5 line-through'
            : isActive
              ? 'bg-accent-600/20 text-accent-300 ring-accent-500/50'
              : 'bg-ink-850 text-zinc-400 ring-white/10 hover:text-zinc-100'
        }`}
      >
        {s.server ?? 'Source'}
        {s.quality && <span className="text-zinc-500">· {s.quality}</span>}
        {s.audio === 'sub' && <Badge variant="sub">Sub</Badge>}
        {s.audio === 'dub' && <Badge variant="dub">Dub</Badge>}
      </button>
    );
  };

  return (
    <PageContainer className="!space-y-5">
      <div className="flex items-center gap-4">
        <Link
          to={`/anime/${id}`}
          className="flex items-center gap-1.5 text-sm text-zinc-400 transition hover:text-white"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        {info.loading ? (
          <Skeleton className="h-6 w-64" />
        ) : (
          <p className="min-w-0 truncate text-sm text-zinc-300">
            {info.data ? (
              <Link to={`/anime/${id}`} className="font-semibold text-white hover:underline">
                {info.data.title}
              </Link>
            ) : (
              <span className="font-semibold text-white">Unknown anime</span>
            )}
            <span className="mx-2 text-zinc-600">·</span>
            Episode {epNum}
          </p>
        )}
        <div className="ml-auto flex shrink-0 items-center rounded-lg bg-ink-850 p-0.5 ring-1 ring-white/10">
          {(['sub', 'dub'] as const).map((a) => (
            <button
              key={a}
              onClick={() => setAudio(a)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                audio === a ? 'bg-accent-600 text-white' : 'text-zinc-400 hover:text-white'
              }`}
            >
              {a === 'sub' ? 'Sub' : 'Dub'}
            </button>
          ))}
        </div>
      </div>

      {/* Player (HTTP sources first, torrent blob as last resort).
          Background merges re-trigger streams.reload() — with data already
          loaded that refresh must NOT unmount the player into a skeleton
          (the "Anivexa erased my source" flash). Skeleton only pre-data. */}
      {streams.loading && !streams.data ? (
        <Skeleton className="aspect-video rounded-2xl" />
      ) : activeSource ? (
        httpPlayer
      ) : torrentSource ? (
        torrentPlayer
      ) : allSources.length === 0 ? null : (
        <ErrorState
          title="No playable stream found"
          message="Every source failed. Retry, or try the torrent fallback below."
          details={streams.data?.errors}
          onRetry={() => {
            setFailedKeys(new Set());
            setActiveKey(null);
            streams.reload();
          }}
        />
      )}

      {/* Episode strip — jump between episodes without going back to the
          detail page. Independent of the info fetch, so it renders fast. */}
      {episodeList.length > 0 && (
        <section className="rounded-2xl bg-ink-900 p-4 ring-1 ring-white/5">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-zinc-500">
            Episodes
            <span className="ml-2 rounded-full bg-ink-800 px-2 py-0.5 text-xs normal-case tracking-normal text-zinc-400 ring-1 ring-white/10">
              {episodeList.length}
            </span>
          </h2>
          <div className="no-scrollbar flex flex-wrap gap-2">
            {episodeList.map((num) => (
              <button
                key={num}
                onClick={() => navigate(`/watch/${id}/${num}`)}
                className={`min-w-[2.75rem] rounded-lg px-2.5 py-1.5 text-xs ring-1 transition ${
                  num === epNum
                    ? 'bg-accent-600/20 font-semibold text-accent-300 ring-accent-500/50'
                    : 'bg-ink-850 text-zinc-400 ring-white/10 hover:text-zinc-100'
                }`}
              >
                {num}
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Torrent fallback — when nothing else worked */}
      {info.data && (
        <TorrentPanel
          animeTitle={info.data.title}
          onStream={(url, label) => {
            setTorrent({ url, label });
          }}
        />
      )}

      {/* Provider availability probe */}
      {info.data && (
        <ProviderCheck animeId={id!} title={info.data.title} episode={epNum} />
      )}

      {/* All sources — one consolidated block. Fastest provider first, the
          rest merge in underneath as they answer. Nothing disappears: dead
          sources stay listed (greyed, unclickable) so a late provider can
          never make the current stream vanish from the list. Stays mounted
          during background merges (streams.reload) — only the pill contents
          update. */}
      {allSources.length > 0 && !torrent && (
        <section className="rounded-2xl bg-ink-900 p-4 ring-1 ring-white/5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-zinc-500">
              <Layers className="h-4 w-4" />
              All Sources
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs normal-case tracking-normal text-zinc-400 ring-1 ring-white/10">
                {live.length}
              </span>
            </h2>
            {dead.length > 0 && (
              <span className="text-xs text-zinc-600">
                {dead.length} unresponsive
              </span>
            )}
          </div>
          {live.length === 0 ? (
            <p className="py-4 text-sm text-zinc-500">
              Every source failed — retry above or use the torrent fallback.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {live.map((s) => renderPill(s, sourceKey(s) === sourceKey(activeSource), false))}
              {dead.map((s) => renderPill(s, false, true))}
            </div>
          )}
        </section>
      )}

      <div className="flex items-center justify-between">
        <Button
          variant="outline"
          size="sm"
          disabled={epNum <= 1}
          onClick={() => navigate(`/watch/${id}/${epNum - 1}`)}
        >
          <ChevronLeft className="h-4 w-4" /> Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasNext}
          onClick={() => navigate(`/watch/${id}/${epNum + 1}`)}
        >
          Next <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="max-w-md">
        <Disclaimer />
      </div>
    </PageContainer>
  );
}
