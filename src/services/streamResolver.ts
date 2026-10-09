import { api } from './api';
import { consumet } from './consumet';
import { animepahe } from './animepahe';
import { anivexa } from './anivexa';
import { anikage } from './anikage';
import { oneanime } from './oneanime';
import { probeAll } from './probe';
import { verifyTitle } from './titleMatch';
import { peekAnimeInfo } from './info';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AudioType, StreamSource, SubtitleTrack } from '@/types';

// Session cache: skipping through a season must not re-fire every
// backend per episode. 10-minute TTL.
const streamCache = new Map<string, { at: number; value: ResolvedStreams }>();
const CACHE_TTL_MS = 10 * 60_000;

/** Fired (with the cache key as detail) when a background merge adds late
 *  provider streams to an already-returned result — pages re-render via
 *  their useApi reload and pick up the grown source list. */
export const streamUpdates = new EventTarget();

export interface ResolvedStreams {
  streams: StreamSource[];
  subtitles?: SubtitleTrack[];
  /** Why each provider failed, in the order they were tried. Surfaced in the
   *  "No playable stream found" screen so failures are diagnosable instead
   *  of silent. Grows as slow providers fail in the background. */
  errors: string[];
  /**
   * True when every provider failed with a "confident miss" (title verifier
   * rejected all candidates, or the provider's listing lacks the episode) —
   * i.e. the anime is genuinely not available, as opposed to a network
   * outage. The UI uses this to say "not available anywhere" instead of the
   * scarier "everything is broken".
   */
  unavailable?: boolean;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Title-verification context for the current resolve: all AniList title
 *  variants plus airing status, read from the ALREADY-FETCHED cached info —
 *  zero extra requests, zero rate-limit exposure. */
function titleContext(animeId: number | string, title: string | undefined) {
  const info = peekAnimeInfo(String(animeId));
  return {
    main: title?.trim() || info?.title || String(animeId),
    alt: info?.altTitles,
    status: info?.status,
  };
}

/** Order streams by the user's provider preference list (prefix match on
 *  "server" so e.g. "anikage:koto" follows "anikage"). */
function prioritize(streams: StreamSource[]): StreamSource[] {
  const order = useSettingsStore.getState().providerPriority;
  const rank = (s: StreamSource) => {
    if (s.verified === false) return 999; // probed dead — sink to the bottom
    const i = order.findIndex((o) => s.server === o || s.server?.startsWith(`${o}:`));
    return i === -1 ? 99 : i;
  };
  return [...streams].sort((a, b) => rank(a) - rank(b));
}

/** Family key of a stream source ("anify:zoro" -> "anify"). */
function familyOf(s: StreamSource): string {
  return (s.server ?? '').split(':')[0].toLowerCase();
}

type ProviderResult = { streams: StreamSource[]; subtitles?: SubtitleTrack[] };

interface TaggedResult {
  /** Lowercase family tag the streams carry in "server" ("anify", "anikage",
   *  "consumet", ...). Kuhi/Anivexa native streams carry bare provider names,
   *  so their tag never matches a family and falls back gracefully. */
  tag: string;
  result: ProviderResult;
}

/**
 * Resolve playable streams for an episode.
 *
 * All providers run IN PARALLEL. The first non-empty result is returned
 * IMMEDIATELY (playback starts, nothing waits). Slower providers merge in
 * the BACKGROUND: their streams (deduped by URL) are appended to the live
 * result and `streamUpdates` fires so the page re-renders with the fuller
 * source list. Adding a provider adds redundancy, not latency.
 *
 * Subtitles follow the provider family of the top-prioritized stream —
 * mixing e.g. AniZone video with MKissa subtitles puts timings off by
 * miles — and are re-checked after every merge.
 */
async function resolveStreamsInner(
  animeId: number | string,
  episode: number,
  audio: AudioType = 'sub',
  title?: string,
  isAdult?: boolean,
): Promise<ResolvedStreams> {
  const titleQ = title?.trim() || String(animeId);
  const errors: string[] = [];
  const settings = useSettingsStore.getState();

  interface Attempt {
    tag: string;
    name: string;
    run: () => Promise<ProviderResult>;
  }

  const nonEmpty = (name: string, r: ProviderResult): ProviderResult => {
    if (!r.streams.length) throw new Error(`${name}: no streams for this episode`);
    return r;
  };

  // Pre-play probing: providers return URLs that often 403/500 on playback.
  // Verify unprobed streams in the background; dead ones sink to the bottom
  // of the list and the page re-renders via streamUpdates. Overlapping passes
  // dedupe through probeStream's inflight map + short cache.
  const verify = async (v: ResolvedStreams) => {
    const unprobed = v.streams.filter((s) => s.verified === undefined);
    if (unprobed.length === 0) return;
    const results = await probeAll(unprobed);
    let changed = false;
    for (const s of v.streams) {
      const ok = results.get(s.url);
      if (ok !== undefined && s.verified !== ok) {
        s.verified = ok;
        changed = true;
      }
    }
    if (changed) {
      v.streams = prioritize(v.streams);
      streamUpdates.dispatchEvent(
        new CustomEvent('update', { detail: `${animeId}|${episode}|${audio}` }),
      );
    }
  };

  // For adult titles, AniKage's exact AniList-ID match is the ONLY
  // trustworthy source: search-based providers often don't index H content,
  // and ID-based aggregators (Anivexa/Kuhi) have been observed returning
  // wrong-anime streams for H IDs. AniKage maps by AniList ID directly, so
  // an exact match there is definitive. We still race other providers as
  // fallback, but AniKage gets a head start.
  // isAdult comes from the caller (Watch page) — peekAnimeInfo returns
  // undefined on F5 reload (empty cache), which would wrongly race all
  // providers for H titles.
  const adult = isAdult ?? peekAnimeInfo(String(animeId))?.isAdult === true;
  console.log(`[streamResolver] animeId=${animeId} isAdult param=${isAdult} peek=${peekAnimeInfo(String(animeId))?.isAdult} adult=${adult} attempts=${adult ? 1 : 'all'}`);

  const attempts: Attempt[] = [
    // Adult titles: ONLY the dedicated H provider via the anime-api sidecar.
    // Generic providers don't index H content or return wrong streams, so
    // they're excluded entirely for adult titles.
    ...(adult
      ? [{
          tag: 'hanime',
          name: 'Hanime',
          run: async () => {
            // The hanime provider lives in the anime-api sidecar. It
            // slugifies AniList titles and probes hstream.moe + hanime.tv.
            const r = await anivexa.watch('hanime', animeId, episode, 'sub');
            return nonEmpty('Hanime', r);
          },
        }]
      : [
    {
      tag: 'kuhi',
      name: 'Kuhi',
      run: async () => {
        const r = await api.extract(animeId, episode, audio);
        return nonEmpty('Kuhi', { streams: r.streams ?? [], subtitles: r.subtitles });
      },
    },
    {
      tag: 'anivexa',
      name: 'Anivexa',
      run: async () => {
        if (!settings.enableAnivexa) throw new Error('Anivexa: disabled in Settings');
        return nonEmpty('Anivexa', await anivexa.watchAll(animeId, episode, audio));
      },
    },
    // Anify removed: api.anify.tv has been unreachable for months (502/timeout
    // on every request) — the provider only wasted a race slot and proxy hits.
    { tag: '1anime', name: '1anime', run: () => oneanime.streams(animeId, episode, audio) },
    {
      tag: 'anikage',
      name: 'AniKage',
      run: async () => {
        const results = await anikage.search(titleQ);
        // AniKage may return anilistId as string OR number depending on the
        // endpoint — coerce both sides before comparing (=== on mismatched
        // types silently fails and the exact-ID match is discarded).
        const wantId = Number(animeId);
        const best = results.find((r) => Number(r.anilistId) === wantId);
        if (!best) throw new Error('AniKage: no exact AniList match');
        // Airing guard: AniKage's search payload carries the episode count.
        // For a RELEASING show a count below the requested episode means the
        // slug is stale (pointing at a partial/older listing) — don't burn
        // rate-limited server probes on it.
        const info = peekAnimeInfo(String(animeId));
        if (
          info?.status === 'RELEASING' &&
          typeof best.episodes === 'number' &&
          best.episodes > 0 &&
          best.episodes < episode
        ) {
          throw new Error('AniKage: listing lacks this episode');
        }
        return nonEmpty('AniKage', await anikage.sources(best.slug, episode, audio));
      },
    },
    {
      tag: 'consumet',
      name: 'Consumet',
      run: async () => {
        if (!settings.enableConsumetFallback) throw new Error('Consumet: disabled in Settings');
        const results = await consumet.search(titleQ);
        // Verify against ALL AniList title variants + airing guard: a partial
        // sequel listing must never hijack the episode (see titleMatch.ts).
        const ctx = titleContext(animeId, title);
        const best = verifyTitle(
          results.map((r) => ({ ...r, episodes: undefined })),
          ctx.main,
          ctx.alt,
          { episode, status: ctx.status },
        );
        if (!best) throw new Error('Consumet: no confident title match');
        const detail = await consumet.info(best.id);
        // Airing guard on the episode list itself: for a RELEASING show the
        // provider must actually carry the requested episode. A short list
        // here means wrong season/partial index — refuse rather than play
        // episode 1 of the wrong anime.
        if (ctx.status === 'RELEASING' && detail.episodes.length < episode) {
          throw new Error('Consumet: episode list too short for airing show');
        }
        const ep =
          detail.episodes.find((e) => e.number === episode) ??
          detail.episodes[episode - 1];
        if (!ep) throw new Error('Consumet: episode not found');
        const watch = await consumet.watch(ep.id);
        const streams: StreamSource[] = (watch.sources ?? [])
          .filter((s) => s?.url)
          .map((s) => ({
            type: s.isM3U8 || s.url.includes('.m3u8') ? 'hls' : 'mp4',
            url: s.url,
            server: 'consumet:gogoanime',
            audio,
            quality: s.quality,
            referer: watch.headers?.Referer,
          }));
        return nonEmpty('Consumet', { streams });
      },
    },
    {
      tag: 'animepahe',
      name: 'animepahe',
      run: async () => {
        const results = await animepahe.search(titleQ);
        const ctx = titleContext(animeId, title);
        // animepahe reports episode counts in search results — feed them to
        // the verifier so the airing guard can reject partial sequel listings.
        const best = verifyTitle(results, ctx.main, ctx.alt, {
          episode,
          status: ctx.status,
        });
        if (!best) throw new Error('animepahe: no confident title match');
        // Airing guard: pahe's count is reliable; a short listing for a
        // RELEASING show means we matched the wrong season.
        if (ctx.status === 'RELEASING' && best.episodes > 0 && best.episodes < episode) {
          throw new Error('animepahe: matched listing lacks this episode');
        }
        const epSession = await animepahe.findEpisode(best.session, episode);
        if (!epSession) throw new Error('animepahe: episode not found');
        const streams = await animepahe.streams(epSession);
        const filtered =
          audio === 'dub' ? streams.filter((s) => s.audio === 'dub') : streams;
        return nonEmpty('animepahe', { streams: filtered.length > 0 ? filtered : streams });
      },
    },
      ]),
  ];

  // Run every attempt concurrently; each failure is recorded (live array,
  // visible even to callers who already received the result) and re-thrown.
  // "Confident miss" errors (verifier rejected the title, episode absent
  // from the listing) mean the provider DOESN'T HAVE this anime — different
  // from a network/500 failure. When every provider confidently misses, the
  // anime is genuinely unavailable and the UI should say so plainly.
  const MISS_RE = /no confident title match|episode not found|lacks this episode|too short for airing|title not found|no page found/i;
  const missFlags: boolean[] = attempts.map(() => false);
  const pending = attempts.map((a, i) =>
    a
      .run()
      .then((result): TaggedResult => ({ tag: a.tag, result }))
      .catch((e: unknown) => {
        const msg = errMsg(e);
        errors.push(msg);
        if (MISS_RE.test(msg)) missFlags[i] = true;
        throw e;
      }),
  );

  const allSettled = Promise.allSettled(pending);

  let first: TaggedResult;
  // For adult titles, only the hanime provider is in the race — await it
  // directly. For regular anime, race all providers.
  try {
    first = adult ? await pending[0] : await Promise.any(pending);
  } catch (e) {
    if (e instanceof AggregateError) {
      const unavailable = missFlags.every(Boolean) && missFlags.length > 0;
      return { streams: [], errors, unavailable };
    }
    throw e;
  }

    // Immediate result — playback starts from this, no merge waiting.
  // Dedupe the winner's own list first: aggregators (Anivexa races ~15
  // sub-providers internally) can return the same URL twice, which both
  // wastes pills and trips React duplicate-key warnings in the sources list.
  const winnerSeen = new Set<string>();
  const winnerStreams = first.result.streams.filter((s) =>
    winnerSeen.has(s.url) ? false : (winnerSeen.add(s.url), true),
  );
  const value: ResolvedStreams = {
    streams: prioritize(winnerStreams),
    subtitles: first.result.subtitles,
    errors,
  };

  // Probe the race winner's streams in the background so dead URLs sink
  // down the list while playback starts.
  void verify(value);

  // Background merge: late providers append streams (deduped) to the LIVE
  // result and fire an update event so pages re-render with the fuller list.
  void (async () => {
    const settled = await Promise.race([
      allSettled,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
    ]);
    if (!settled) return;

    const ok: TaggedResult[] = (
      settled.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<TaggedResult>[]
    ).map((r) => r.value);

    const seen = new Set(value.streams.map((s) => s.url));
    let added = 0;
    for (const { result } of ok) {
      for (const s of result.streams) {
        if (seen.has(s.url)) continue;
        seen.add(s.url);
        value.streams.push(s);
        added++;
      }
    }
    if (added > 0) value.streams = prioritize(value.streams);

    // Subtitles follow the provider family of the top-prioritized stream.
    if (value.streams.length > 0) {
      const topFamily = familyOf(value.streams[0]);
      const better = ok.find(
        (t) => t.tag === topFamily && t.result.subtitles && t.result.subtitles.length > 0,
      );
      if (better) value.subtitles = better.result.subtitles;
    }

    // Newly merged streams need verification too.
    void verify(value);

    if (added > 0) {
      streamUpdates.dispatchEvent(
        new CustomEvent('update', { detail: `${animeId}|${episode}|${audio}` }),
      );
    }
  })();

  return value;
}

export async function resolveStreams(
  animeId: number | string,
  episode: number,
  audio: AudioType = 'sub',
  title?: string,
  isAdult?: boolean,
): Promise<ResolvedStreams> {
  // Include isAdult in the cache key — a cached "all providers" result must
  // never be served for an H title (and vice versa).
  const key = `${animeId}|${episode}|${audio}|${isAdult === true ? 'a' : 'n'}`;
  const hit = streamCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    // Fresh wrapper so React sees new state on reload; the streams array may
    // have grown via a background merge since the last read.
    const v = hit.value;
    return { streams: [...v.streams], subtitles: v.subtitles, errors: v.errors };
  }
  const value = await resolveStreamsInner(animeId, episode, audio, title, isAdult);
  streamCache.set(key, { at: Date.now(), value });
  return value;
}