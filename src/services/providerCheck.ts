import { api } from './api';
import { anikage } from './anikage';
import { consumet } from './consumet';
import { animepahe } from './animepahe';
import { anivexa } from './anivexa';
import { useSettingsStore } from '@/stores/settingsStore';

export interface ProviderStatus {
  name: string;
  status: 'ok' | 'empty' | 'error';
  detail: string;
}

const guard = (name: string, p: Promise<ProviderStatus>): Promise<ProviderStatus> =>
  p.catch(
    (e): ProviderStatus => ({
      name,
      status: 'error',
      detail: e instanceof Error ? e.message : 'probe failed',
    }),
  );

/** Probe every backend for one anime. */
export async function checkProviders(
  animeId: number | string,
  title: string,
  episode = 1,
): Promise<ProviderStatus[]> {
  const s = useSettingsStore.getState();
  const titleQ = title?.trim() || String(animeId);

  const jobs: Promise<ProviderStatus>[] = [
    guard('Kuhi (native race)', (async () => {
      const r = await api.extract(animeId, episode, 'sub');
      return {
        name: 'Kuhi (native race)',
        status: r.streams?.length ? 'ok' : 'empty',
        detail: r.streams?.length ? `${r.streams.length} stream(s) for ep ${episode}` : 'no streams returned',
      };
    })()),
  ];

  if (s.enableAnivexa) {
    jobs.push(guard('Anivexa (15 providers)', (async () => {
      const j = await anivexa.episodes(animeId);
      const providers = (j as Record<string, unknown>)?.providers ?? j;
      const entries =
        providers && typeof providers === 'object'
          ? Object.entries(providers as Record<string, unknown>)
          : [];
      const matched = entries.filter(([, v]) => {
        if (!v || typeof v !== 'object') return false;
        const eps = (v as Record<string, unknown>).episodes;
        if (Array.isArray(eps)) return eps.length > 0;
        if (eps && typeof eps === 'object') {
          const lists = eps as Record<string, unknown>;
          return Object.values(lists).some((l) => Array.isArray(l) && l.length > 0);
        }
        return false;
      });
      return {
        name: 'Anivexa (15 providers)',
        status: matched.length ? 'ok' : 'empty',
        detail: matched.length ? matched.map(([k]) => k).join(', ') : 'no provider matched',
      };
    })()));
  }

  jobs.push(guard('AniKage', (async () => {
    const results = await anikage.search(titleQ);
    const exact = results.find((r) => r.anilistId === Number(animeId));
    const first = exact ?? results[0];
    return {
      name: 'AniKage',
      status: first ? 'ok' : 'empty',
      detail: first
        ? `${exact ? 'exact ID match' : 'fuzzy match'}: ${first.title?.english ?? first.title?.romaji ?? first.slug}`
        : 'no results',
    };
  })()));

  if (s.enableConsumetFallback) {
    jobs.push(guard('Consumet (gogoanime)', (async () => {
      const results = await consumet.search(titleQ);
      return {
        name: 'Consumet (gogoanime)',
        status: results.length ? 'ok' : 'empty',
        detail: results.length ? `${results.length} result(s)` : 'no results',
      };
    })()));
  }

  jobs.push(guard('animepahe', (async () => {
    const results = await animepahe.search(titleQ);
    return {
      name: 'animepahe',
      status: results.length ? 'ok' : 'empty',
      detail: results.length ? `${results.length} result(s)` : 'no results',
    };
  })()));

  return Promise.all(jobs);
}
