import { useEffect, useState } from 'react';

export interface SkipInterval {
  start: number;
  end: number;
}

/** Both skip windows for an episode; either can be missing. */
export interface SkipTimes {
  op: SkipInterval | null;
  ed: SkipInterval | null;
}

/* AniSkip status (2026): api.aniskip.com is dead (parked domain), aniskip.com
 * is gone. The community dataset survives through third-party mirrors —
 * try each endpoint until one answers. Field names are parsed defensively
 * (camelCase AND snake_case) because the mirrors and the old API differ. */
const ENDPOINTS = [
  'https://api.aniskip.com/api/v2',
  'https://aniskip-mirror.vercel.app/v2',
  'https://aniskip-mirror-cf.yasar-123-sevda.workers.dev/v2',
];

const cache = new Map<string, SkipTimes | null>();

/* AniSkip's dataset is keyed by MyAnimeList ID, not AniList ID. Resolve
 * idMal once per anime (session cache). */
const malIdCache = new Map<number, number | null>();

async function resolveMalId(anilistId: number): Promise<number | null> {
  if (malIdCache.has(anilistId)) return malIdCache.get(anilistId)!;
  let malId: number | null = null;
  try {
    const res = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `query($id:Int){Media(id:$id){idMal}}`,
        variables: { id: anilistId },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      malId = data?.data?.Media?.idMal ?? null;
    }
  } catch {
    /* offline / rate-limited — continue without MAL id */
  }
  malIdCache.set(anilistId, malId);
  return malId;
}

interface RawSkip {
  skipType?: string;
  skip_type?: string;
  interval?: { startTime?: number; endTime?: number; start_time?: number; end_time?: number };
}

function parseTimes(data: unknown): SkipTimes | null {
  const results = ((data as { results?: RawSkip[] })?.results ?? []).filter(Boolean);
  const pick = (...types: string[]): SkipInterval | null => {
    const hit = results.find((r) => types.includes(r.skipType ?? r.skip_type ?? ''));
    if (!hit?.interval) return null;
    const iv = hit.interval;
    const start = iv.startTime ?? iv.start_time ?? 0;
    const end = iv.endTime ?? iv.end_time ?? 0;
    return end > start ? { start, end } : null; // ignore empty/inverted windows
  };
  const times: SkipTimes = {
    op: pick('op', 'mixed-op'),
    ed: pick('ed', 'mixed-ed'),
  };
  return times.op || times.ed ? times : null;
}

type QueryResult =
  | { status: 'hit'; times: SkipTimes }
  /** Endpoint answered: 404 / empty dataset. Normal for most episodes. */
  | { status: 'miss' }
  /** Timeout / DNS / CORS / 5xx — the endpoint itself is unhealthy. */
  | { status: 'error' };

/* Per-session memory so a missing episode costs one request per endpoint,
 * not one per re-render, and a dead mirror isn't retried for every sibling
 * episode. (The browser still prints its own "404" network line for the
 * first request; that line can't be suppressed from JS and is harmless.) */
const missCache = new Set<string>();
const endpointDownUntil = new Map<string, number>();
const ENDPOINT_COOLDOWN_MS = 5 * 60_000;

async function query(
  base: string,
  id: number,
  episode: number,
  signal?: AbortSignal,
): Promise<QueryResult> {
  const missKey = `${base}|${id}|${episode}`;
  if (missCache.has(missKey)) return { status: 'miss' };
  if ((endpointDownUntil.get(base) ?? 0) > Date.now()) return { status: 'error' };

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const t = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const res = await fetch(`${base}/skip-times/${id}/${episode}?types[]=op&types[]=ed`, {
      signal: ctrl.signal,
    });
    if (res.status === 404) {
      // "No skip data for this episode" — an expected answer, not a failure.
      missCache.add(missKey);
      return { status: 'miss' };
    }
    if (!res.ok) {
      endpointDownUntil.set(base, Date.now() + ENDPOINT_COOLDOWN_MS);
      return { status: 'error' };
    }
    const times = parseTimes(await res.json());
    if (!times) {
      missCache.add(missKey);
      return { status: 'miss' };
    }
    return { status: 'hit', times };
  } catch {
    if (!signal?.aborted) endpointDownUntil.set(base, Date.now() + ENDPOINT_COOLDOWN_MS);
    return { status: 'error' };
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function fetchSkipTimes(
  anilistId: number,
  episode: number,
  signal?: AbortSignal,
): Promise<SkipTimes | null> {
  const malId = await resolveMalId(anilistId);
  const ids = malId != null ? [malId] : [anilistId];

  // 1) Exact episode, every endpoint, every known ID type.
  let answering: { base: string; id: number } | null = null; // first endpoint that said "no data"
  for (const id of ids) {
    for (const base of ENDPOINTS) {
      if (signal?.aborted) return null;
      const r = await query(base, id, episode, signal);
      if (r.status === 'hit') return r.times;
      if (r.status === 'miss' && !answering) answering = { base, id };
    }
  }

  // 2) Cross-episode fallback: broadcast shows reuse identical OP/ED at
  //    fixed timestamps. If this episode has no data, borrow the nearest
  //    sibling's windows (skipping ep < 1). Rarely wrong (recap/special
  //    episodes); still far better than never showing the button.
  //    Only the endpoint that already answered is asked (3 mirrors x 4
  //    siblings used to be 12 extra requests); if every mirror is down,
  //    sibling lookups would just fail the same way, so none are made.
  if (!answering) return null;
  for (const delta of [1, -1, 2, -2]) {
    const ep = episode + delta;
    if (ep < 1) continue;
    if (signal?.aborted) return null;
    const r = await query(answering.base, answering.id, ep, signal);
    if (r.status === 'hit') return r.times;
  }
  return null;
}

/**
 * AniSkip intro/outro times for an episode (AniList ID + episode number).
 * Internally resolves the MAL id, tries every known API mirror, and falls
 * back to a sibling episode's windows when the exact episode has no data.
 * Returns null only when nothing at all is available.
 */
export function useIntroSkip(animeId: string, episode: number): SkipTimes | null {
  const [skip, setSkip] = useState<SkipTimes | null>(() => {
    const key = `${animeId}|${episode}`;
    return cache.has(key) ? cache.get(key)! : null;
  });

  useEffect(() => {
    const key = `${animeId}|${episode}`;
    if (cache.has(key)) {
      setSkip(cache.get(key)!);
      return;
    }
    // Missing data is a normal outcome: resolve to null, never reject, and
    // never touch playback. Aborting on unmount keeps stale lookups quiet.
    const ctrl = new AbortController();
    setSkip(null);
    fetchSkipTimes(Number(animeId), episode, ctrl.signal)
      .then((s) => {
        if (ctrl.signal.aborted) return;
        cache.set(key, s);
        setSkip(s);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) cache.set(key, null);
      });
    return () => ctrl.abort();
  }, [animeId, episode]);

  return skip;
}