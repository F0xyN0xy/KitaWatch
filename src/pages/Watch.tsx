import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Layers, LoaderCircle } from 'lucide-react';
import PageContainer from '@/components/layout/PageContainer';
import VideoPlayer from '@/components/player/VideoPlayer';
import TorrentPanel from '@/components/player/TorrentPanel';
import ProviderCheck from '@/components/player/ProviderCheck';
import WatchStatusControl from '@/components/player/WatchStatusControl';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import Skeleton from '@/components/ui/Skeleton';
import ErrorState from '@/components/ui/ErrorState';
import Disclaimer from '@/components/ui/Disclaimer';
import { providerPreferenceKey, resolveStreams, streamUpdates } from '@/services/streamResolver';
import { fetchAnimeInfo } from '@/services/info';
import { api } from '@/services/api';
import { useApi } from '@/hooks/useApi';
import { useSettingsStore } from '@/stores/settingsStore';
import { useHistoryStore } from '@/stores/historyStore';
import { useAnimeStore } from '@/stores/animeStore';
import { setDiscordPresence, clearDiscordPresence } from '@/services/discord';
import type { StreamSource } from '@/types';

// Cached + AniList-first info fetcher: instant on revisits, and roughly
// halves the AniList traffic that was getting the app rate-limited (the old
// version raced api.info and anilist.info in parallel on every page open).
const fetchInfo = fetchAnimeInfo;

/** Identity of a source — survives list re-sorts and background merges. */
const sourceKey = (s: StreamSource) => `${s.server ?? 'src'}|${s.url}`;

interface WatchProps {
  id: string;
  episode: string;
}

export default function Watch({ id, episode }: WatchProps) {
  const navigate = useNavigate();
  const epNum = Number(episode) || 1;
  const autoplayNext = useSettingsStore((s) => s.autoplayNext);
  const autoTrackKitaWatch = useSettingsStore((s) => s.autoTrackKitaWatch);
  const trackInKitaWatch = useAnimeStore((s) => s.trackInKitaWatch);
  const preferredSubProvider = useSettingsStore((s) => s.preferredSubProvider);
  const preferredDubProvider = useSettingsStore((s) => s.preferredDubProvider);

  const info = useApi(() => fetchInfo(id), [id]);
  // Episode metadata is optional: providers may not expose titles or
  // episode-specific artwork. Keep navigation fully usable without it.
  const episodeMetadata = useApi(() => api.episodes(id), [id], { retries: 1 });
  const episodeByNumber = new Map(
    (episodeMetadata.data ?? []).map((item) => [item.number, item] as const),
  );
  // Episode strip: AniList's official count, capped at the latest AIRED
  // episode for ongoing shows (nextAiringEpisode = next unaired ep). Without
  // the cap, clicking a not-yet-aired episode sent providers hunting for
  // something that doesn't exist — and some answered with a DIFFERENT
  // anime's stream instead of a clean miss.
  const epTotal = info.data?.totalEpisodes;
  const latestAired = info.data?.nextAiringEpisode
    ? Math.min(info.data.nextAiringEpisode - 1, epTotal ?? Infinity)
    : epTotal;
  const episodeList: number[] =
    latestAired && latestAired > 0 && latestAired <= 5000
      ? Array.from({ length: latestAired }, (_, i) => i + 1)
      : [];
  // Block pagination for long shows (One Piece…): 100 episodes per block,
  // e.g. "1–100 · 101–200 · 201–300". Short shows render a single block
  // and no selector.
  const BLOCK = 100;
  const blockCount = Math.max(1, Math.ceil(episodeList.length / BLOCK));
  const [epBlock, setEpBlock] = useState(0);
  // Keep the visible block in sync when the anime/episode changes (e.g.
  // clicking Next on ep 100 must flip the strip to 101–200).
  useEffect(() => {
    setEpBlock(Math.min(Math.floor((epNum - 1) / BLOCK), blockCount - 1));
  }, [id, epNum, blockCount]);
  const blockEpisodes = episodeList.slice(epBlock * BLOCK, (epBlock + 1) * BLOCK);
  const [audio, setAudio] = useState<'sub' | 'dub'>('sub');
  // Hard guard: never resolve streams for an episode that hasn't aired.
  // Providers can't have it — some return a clean miss, others (Kuhi/Anivexa
  // fallbacks) return a DIFFERENT anime's stream, which is far worse.
  // NEVER resolve streams until the anime info has loaded. On first visit
  // or F5 reload, info.data is null — firing the resolver then means
  // isAdult is undefined (treated as false), so ALL providers race for
  // H-animes and the wrong anime plays. The 10-minute stream cache then
  // keeps that wrong result even after info arrives.
  const infoLoaded = info.data != null;
  const epAired =
    info.data == null ||
    info.data.nextAiringEpisode == null ||
    epNum < info.data.nextAiringEpisode;
  const streams = useApi(
    () =>
      infoLoaded && epAired
        ? resolveStreams(id!, epNum, audio, info.data?.title, info.data?.isAdult)
        : Promise.resolve({ streams: [], errors: [], unavailable: !infoLoaded ? undefined : true }),
    [id, epNum, audio, info.data?.title, info.data?.isAdult, epAired, infoLoaded],
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
        rating: info.data.rating,
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
  // "Next" only when the next episode has actually aired. For airing shows
  // nextAiringEpisode is the first UNAIRED ep, so epNum+1 must be strictly
  // below it; for finished/unknown shows fall back to the total count.
  const hasNext =
    info.data?.nextAiringEpisode != null
      ? epNum + 1 < info.data.nextAiringEpisode
      : totalEpisodes == null || epNum < totalEpisodes;

  const httpPlayer = activeSource && (
    <VideoPlayer
      key={sourceKey(activeSource)}
      source={activeSource}
      animeId={id!}
      episodeNumber={epNum}
      hasNextEpisode={hasNext}
      autoplayNext={autoplayNext}
      subtitles={activeSource.subtitles}
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
    audio,
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

  // Maintain a local, platform-specific list only when the user opts in and
  // a playable source has been selected. This is separate from AniList sync.
  useEffect(() => {
    if (!autoTrackKitaWatch || !info.data || (!activeSource && !torrent)) return;
    trackInKitaWatch(info.data);
  }, [autoTrackKitaWatch, info.data, activeSource, torrent, trackInKitaWatch]);

  const renderPill = (s: StreamSource, isActive: boolean, isDeadPill: boolean) => {
    const key = sourceKey(s);
    const providerKey = providerPreferenceKey(s.server);
    const savedProvider = audio === 'dub' ? preferredDubProvider : preferredSubProvider;
    const isPreferred = Boolean(providerKey) && providerPreferenceKey(savedProvider) === providerKey;
    return (
      <div key={key} className="flex items-center gap-1">
        <button
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
        {!isDeadPill && providerKey && (
          <button
            type="button"
            onClick={() => {
              const current = useSettingsStore.getState();
              if (audio === 'dub') current.setPreferredDubProvider(providerKey);
              else current.setPreferredSubProvider(providerKey);
              setActiveKey(key);
            }}
            title={isPreferred ? `Preferred ${audio.toUpperCase()} provider` : `Remember for ${audio.toUpperCase()}`}
            aria-label={isPreferred ? `Preferred ${audio.toUpperCase()} provider: ${s.server}` : `Remember ${s.server} for ${audio.toUpperCase()}`}
            className={`rounded-full px-2 py-1.5 text-[10px] ring-1 transition ${
              isPreferred
                ? 'bg-accent-600/20 text-accent-300 ring-accent-500/40'
                : 'bg-ink-850 text-zinc-500 ring-white/10 hover:text-zinc-100'
            }`}
          >
            {isPreferred ? 'Preferred' : 'Remember'}
          </button>
        )}
      </div>
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
            {episodeByNumber.get(epNum)?.title && (
              <span className="text-zinc-400"> — {episodeByNumber.get(epNum)?.title}</span>
            )}
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

      {info.data && <WatchStatusControl mediaId={Number(id)} />}

      {/* Player (HTTP sources first, torrent blob as last resort).
          Background merges re-trigger streams.reload() — with data already
          loaded that refresh must NOT unmount the player into a skeleton
          (the "Anivexa erased my source" flash). Skeleton only pre-data. */}
      {info.loading || (!infoLoaded && !info.error) || (streams.loading && allSources.length === 0) ? (
        <div
          className="flex aspect-video flex-col items-center justify-center gap-3 rounded-2xl bg-ink-900 text-zinc-400 ring-1 ring-white/5"
          role="status"
          aria-live="polite"
        >
          <LoaderCircle className="h-7 w-7 animate-spin text-accent-400" />
          <p className="text-sm">Finding a playable stream…</p>
          <p className="text-xs text-zinc-600">Checking available providers for episode {epNum}</p>
        </div>
      ) : info.error ? (
        <ErrorState
          title="Couldn't load anime information"
          message={info.error}
          onRetry={info.reload}
        />
      ) : activeSource ? (
        httpPlayer
      ) : torrentSource ? (
        torrentPlayer
      ) : allSources.length === 0 ? (
        streams.data ? (
          <ErrorState
            title={
              streams.data.errors.some((e) =>
                /cannot be played in-app|X-Frame-Options|frame-ancestors|no provider-supported embed/i.test(e),
              )
                ? 'Provider cannot be embedded'
                : streams.data.unavailable
                  ? 'Not available on any provider'
                  : 'No playable stream found'
            }
            message={
              streams.data.errors.some((e) =>
                /cannot be played in-app|X-Frame-Options|frame-ancestors|no provider-supported embed/i.test(e),
              )
                ? 'The provider was found, but it does not expose a playback method supported by KitaWatch. The app cannot override the provider’s framing restrictions.'
                : streams.data.unavailable
                  ? 'No provider carries this episode right now. Try again later.'
                  : 'No playable source was returned. Check the diagnostic details below or retry.'
            }
            details={streams.data.errors}
            onRetry={() => {
              setFailedKeys(new Set());
              setActiveKey(null);
              streams.reload();
            }}
          />
        ) : null
      ) : (
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
          detail page. Only AIRED episodes are listed (see latestAired), and
          long shows paginate in 100-episode blocks. */}
      {episodeList.length > 0 && (
        <section className="rounded-2xl bg-ink-900 p-4 ring-1 ring-white/5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-zinc-500">
              Episodes
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs normal-case tracking-normal text-zinc-400 ring-1 ring-white/10">
                {episodeList.length}
              </span>
            </h2>
            {blockCount > 1 && (
              <div className="flex flex-wrap gap-1">
                {Array.from({ length: blockCount }, (_, b) => {
                  const start = b * BLOCK + 1;
                  const end = Math.min((b + 1) * BLOCK, episodeList.length);
                  const active = b === epBlock;
                  return (
                    <button
                      key={b}
                      onClick={() => setEpBlock(b)}
                      className={`rounded-md px-2 py-1 text-xs ring-1 transition ${
                        active
                          ? 'bg-accent-600/20 font-semibold text-accent-300 ring-accent-500/50'
                          : 'bg-ink-850 text-zinc-400 ring-white/10 hover:text-zinc-100'
                      }`}
                    >
                      {start}–{end}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <div className="no-scrollbar flex flex-wrap gap-2">
            {blockEpisodes.map((num) => {
              const metadata = episodeByNumber.get(num);
              const title = metadata?.title?.trim();
              const thumbnail = metadata?.thumbnail?.trim();
              return (
                <button
                  key={num}
                  type="button"
                  aria-current={num === epNum ? 'page' : undefined}
                  aria-label={`Episode ${num}${title ? `: ${title}` : ''}`}
                  onClick={() => navigate(`/watch/${id}/${num}`)}
                  className={`w-32 shrink-0 overflow-hidden rounded-lg text-left ring-1 transition ${
                    num === epNum
                      ? 'bg-accent-600/20 text-accent-300 ring-accent-500/50'
                      : 'bg-ink-850 text-zinc-400 ring-white/10 hover:text-zinc-100'
                  }`}
                >
                  <span className="relative flex aspect-video items-center justify-center overflow-hidden bg-ink-800 text-sm font-semibold">
                    <span aria-hidden="true">{num}</span>
                    {thumbnail && (
                      <img
                        src={thumbnail}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 h-full w-full object-cover"
                        onError={(event) => {
                          event.currentTarget.style.display = 'none';
                        }}
                      />
                    )}
                  </span>
                  <span className="block px-2 py-2">
                    <span className="block text-xs font-medium">Episode {num}</span>
                    {title && (
                      <span className="mt-1 block truncate text-[11px] text-zinc-500" title={title}>
                        {title}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
          {info.data?.nextAiringEpisode != null && info.data?.nextAiringAt != null && (
            <p className="mt-3 text-xs text-zinc-600">
              Episode {info.data.nextAiringEpisode} airs{' '}
              {new Date(info.data.nextAiringAt * 1000).toLocaleString()}.
            </p>
          )}
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
            <div>
              <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-zinc-500">
                <Layers className="h-4 w-4" />
                All Sources
                <span className="rounded-full bg-ink-800 px-2 py-0.5 text-xs normal-case tracking-normal text-zinc-400 ring-1 ring-white/10">
                  {live.length}
                </span>
              </h2>
              <p className="mt-1 text-xs text-zinc-600">
                Choose a source, then press Remember to prefer it for future {audio.toUpperCase()} episodes.
              </p>
            </div>
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
