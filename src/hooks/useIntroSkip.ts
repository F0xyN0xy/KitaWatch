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
    return { start: iv.startTime ?? iv.start_time ?? 0, end: iv.endTime ?? iv.end_time ?? 0 };
  };
  const times: SkipTimes = {
    op: pick('op', 'mixed-op'),
    ed: pick('ed', 'mixed-ed'),
  };
  return times.op || times.ed ? times : null;
}

async function query(base: string, id: number, episode: number): Promise<SkipTimes | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6_000);
  try {
    const res = await fetch(`${base}/skip-times/${id}/${episode}?types[]=op&types[]=ed`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return parseTimes(await res.json());
  } catch {
    return null; // timeout / DNS / CORS — try the next endpoint
  } finally {
    clearTimeout(t);
  }
}

async function fetchSkipTimes(anilistId: number, episode: number): Promise<SkipTimes | null> {
  const malId = await resolveMalId(anilistId);
  const ids = malId != null ? [malId] : [anilistId];

  // 1) Exact episode, every endpoint, every known ID type.
  for (const id of ids) {
    for (const base of ENDPOINTS) {
      const times = await query(base, id, episode);
      if (times) return times;
    }
  }

  // 2) Cross-episode fallback: broadcast shows reuse identical OP/ED at
  //    fixed timestamps. If this episode has no data, borrow the nearest
  //    sibling's windows (skipping ep < 1). Rarely wrong (recap/special
  //    episodes); still far better than never showing the button.
  for (const delta of [1, -1, 2, -2]) {
    const ep = episode + delta;
    if (ep < 1) continue;
    for (const id of ids) {
      for (const base of ENDPOINTS) {
        const times = await query(base, id, ep);
        if (times) return times;
      }
    }
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
    let live = true;
    fetchSkipTimes(Number(animeId), episode)
      .then((s) => {
        cache.set(key, s);
        if (live) setSkip(s);
      })
      .catch(() => cache.set(key, null));
    return () => {
      live = false;
    };
  }, [animeId, episode]);

  return skip;
}