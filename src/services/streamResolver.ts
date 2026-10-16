import { api } from './api';
import { consumet } from './consumet';
import { animepahe } from './animepahe';
import { anivexa } from './anivexa';
import { anikage } from './anikage';
import { oneanime } from './oneanime';
import { probeAll } from './probe';
import { verifyTitle } from './titleMatch';
import { peekAnimeInfo } from './info';
import { classifySourceKind } from './sourceType';
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
  const order = useSettingsStore.getState().providerPriority.map((p) => p.toLowerCase());

  const rank = (s: StreamSource) => {
    if (s.verified === false) return 999; // probed dead — sink to the bottom

    const server = (s.server ?? '').toLowerCase();
    // Anivexa labels its streams "anivexa:<provider>", while the settings
    // list stores the provider name by itself (e.g. "anizone"). Compare
    // both the complete tag and the nested provider name.
    const candidates = server.startsWith('anivexa:')
      ? [server, server.slice('anivexa:'.length), 'anivexa']
      : [server];

    let best = 99;
    for (const candidate of candidates) {
      const i = order.findIndex(
        (entry) => candidate === entry || candidate.startsWith(`${entry}:`),
      );
      if (i !== -1) best = Math.min(best, i);
    }
    return best;
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
        // Never default an unrecognised URL to mp4 — drop what can't be typed.
        const streams: StreamSource[] = [];
        for (const s of watch.sources ?? []) {
          if (!s?.url) continue;
          const type = classifySourceKind(s.isM3U8 ? 'hls' : undefined, s.url);
          if (type === 'unknown' || type === 'embed') continue;
          streams.push({
            type,
            url: s.url,
            server: 'consumet:gogoanime',
            audio,
            quality: s.quality,
            referer: watch.headers?.Referer,
          });
        }
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

  // Run every attempt concurrently. Show the first successful result immediately,
  // then merge each later provider as soon as it resolves. Do not wait for
  // Promise.allSettled: a single hung provider must not block Anivexa/AniKage
  // sources that have already been found.
  const MISS_RE = /no confident title match|episode not found|lacks this episode|too short for airing|title not found|no page found/i;
  const missFlags: boolean[] = attempts.map(() => false);
  const completed: TaggedResult[] = [];
  let liveValue: ResolvedStreams | undefined;
  const mergeResult = (tagged: TaggedResult) => {
    if (!liveValue) return;

    const seen = new Set(liveValue.streams.map((s) => s.url));
    let added = 0;
    for (const s of tagged.result.streams) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      liveValue.streams.push(s);
      added++;
    }

    const sorted = prioritize(liveValue.streams);
    const orderChanged = sorted.some((s, i) => s !== liveValue!.streams[i]);
    if (added > 0 || orderChanged) liveValue.streams = sorted;

    // Keep subtitles aligned with the highest-priority provider family.
    const topFamily = liveValue.streams.length > 0 ? familyOf(liveValue.streams[0]) : '';
    if (
      tagged.tag === topFamily &&
      tagged.result.subtitles &&
      tagged.result.subtitles.length > 0
    ) {
      liveValue.subtitles = tagged.result.subtitles;
    }

    if (added > 0 || orderChanged) {
      streamUpdates.dispatchEvent(
        new CustomEvent('update', { detail: `${animeId}|${episode}|${audio}` }),
      );
      void verify(liveValue);
    }
  };

  const pending = attempts.map((a, i) =>
    a.run()
      .then((result): TaggedResult => {
        // Preserve provider-specific subtitle lists when present. Otherwise,
        // attach the provider-level list to its streams so switching sources
        // also switches the subtitles instead of keeping a stale global track.
        const sourceResult: ProviderResult = {
          ...result,
          streams: result.streams.map((stream) => ({
            ...stream,
            subtitles: stream.subtitles ?? result.subtitles ?? [],
          })),
        };
        const tagged = { tag: a.tag, result: sourceResult };
        completed.push(tagged);
        // If the first result has already been published, merge this provider
        // immediately instead of waiting for slower unrelated providers.
        if (liveValue) mergeResult(tagged);
        return tagged;
      })
      .catch((e: unknown) => {
        const msg = errMsg(e);
        errors.push(msg);
        if (MISS_RE.test(msg)) missFlags[i] = true;
        throw e;
      }),
  );

  let first: TaggedResult;
  try {
    // For adult titles, only the dedicated Hanime provider is in the race.
    // For regular titles, the first provider to succeed starts playback.
    first = adult ? await pending[0] : await Promise.any(pending);
  } catch (e) {
    if (adult || e instanceof AggregateError) {
      const unavailable = missFlags.length > 0 && missFlags.every(Boolean);
      return { streams: [], errors, unavailable };
    }
    throw e;
  }

  // Immediate result — playback starts from the first successful provider.
  const winnerSeen = new Set<string>();
  const winnerStreams = first.result.streams.filter((s) =>
    winnerSeen.has(s.url) ? false : (winnerSeen.add(s.url), true),
  );
  liveValue = {
    streams: prioritize(winnerStreams),
    subtitles: first.result.subtitles,
    errors,
  };

  // Providers may resolve in the small interval between Promise.any winning
  // and liveValue being assigned. Merge anything already completed now.
  for (const tagged of completed) {
    if (tagged !== first) mergeResult(tagged);
  }

  // Probe existing streams without delaying the live provider merge.
  void verify(liveValue);

  if (!liveValue) throw new Error('Stream resolver completed without a result');
  return liveValue;
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
    return {
      streams: [...v.streams],
      subtitles: v.subtitles,
      errors: v.errors,
      unavailable: v.unavailable,
    };
  }
  const value = await resolveStreamsInner(animeId, episode, audio, title, isAdult);
  streamCache.set(key, { at: Date.now(), value });
  return value;
}