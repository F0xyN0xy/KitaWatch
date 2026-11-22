import { api } from './api';
import { probeAll } from './probe';
import { peekAnimeInfo } from './info';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AudioType, StreamSource, SubtitleTrack } from '@/types';

// Session cache: skipping through a season must not re-fire the API for every
// episode. The backend also caches provider results where appropriate.
const streamCache = new Map<string, { at: number; value: ResolvedStreams }>();
const CACHE_TTL_MS = 10 * 60_000;

/** Fired when background stream verification changes source ordering/status. */
export const streamUpdates = new EventTarget();

export interface ResolvedStreams {
  streams: StreamSource[];
  subtitles?: SubtitleTrack[];
  errors: string[];
  unavailable?: boolean;
}

const errMsg = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Normalize provider names for saved provider preferences. */
export function providerPreferenceKey(server?: string): string {
  const raw = (server ?? '').trim().toLowerCase();
  if (!raw) return '';
  const withoutAggregator = raw.startsWith('anivexa:')
    ? raw.slice('anivexa:'.length)
    : raw;
  return withoutAggregator.split(':')[0].replace(/[^a-z0-9]/g, '');
}

/** Keep the user's preferred source first without discarding fallbacks. */
function prioritize(streams: StreamSource[]): StreamSource[] {
  const settings = useSettingsStore.getState();
  const order = settings.providerPriority.map((provider) => provider.toLowerCase());

  const rank = (stream: StreamSource) => {
    if (stream.verified === false) return 999;

    const provider = providerPreferenceKey(stream.server);
    const preferred = providerPreferenceKey(
      stream.audio === 'dub'
        ? settings.preferredDubProvider
        : settings.preferredSubProvider,
    );
    const matchesPreferred = Boolean(preferred) && provider === preferred;
    const server = (stream.server ?? '').toLowerCase();
    const candidates = server.startsWith('anivexa:')
      ? [server, server.slice('anivexa:'.length), 'anivexa']
      : [server];

    let best = matchesPreferred ? -1 : 99;
    for (const candidate of candidates) {
      const index = order.findIndex(
        (entry) => candidate === entry || candidate.startsWith(`${entry}:`),
      );
      if (index !== -1) best = Math.min(best, index);
    }
    return best;
  };

  return [...streams].sort((left, right) => rank(left) - rank(right));
}

/** Verify discovered sources in the background; this never delays playback. */
async function verifyStreams(
  value: ResolvedStreams,
  animeId: number | string,
  episode: number,
  audio: AudioType,
): Promise<void> {
  const unprobed = value.streams.filter((stream) => stream.verified === undefined);
  if (unprobed.length === 0) return;

  try {
    const results = await probeAll(unprobed);
    let changed = false;
    for (const stream of value.streams) {
      const verdict = results.get(stream.url);
      if (verdict !== undefined && stream.verified !== verdict) {
        stream.verified = verdict;
        changed = true;
      }
    }
    if (changed) {
      value.streams = prioritize(value.streams);
      streamUpdates.dispatchEvent(
        new CustomEvent('update', { detail: `${animeId}|${episode}|${audio}` }),
      );
    }
  } catch (error) {
    console.warn('[KitaWatch] Stream verification failed:', errMsg(error));
  }
}

/**
 * Resolve playback through the KitaWatch API only.
 *
 * Provider discovery and matching now happen server-side. The local proxy is
 * still used later by the player for HLS playlist/segment rewriting and
 * referer-sensitive media delivery; it is not a provider discovery service.
 */
async function resolveStreamsInner(
  animeId: number | string,
  episode: number,
  audio: AudioType = 'sub',
  title?: string,
  isAdult?: boolean,
): Promise<ResolvedStreams> {
  void title;

  // Adult-content providers are intentionally unavailable in the current app.
  // Do not send adult-title playback requests to general-purpose providers.
  const adult = isAdult ?? peekAnimeInfo(String(animeId))?.isAdult === true;
  if (adult) {
    return {
      streams: [],
      errors: ['Adult-content playback is currently unavailable.'],
      unavailable: true,
    };
  }

  try {
    const settings = useSettingsStore.getState();
    const response = await api.watch(
      animeId,
      episode,
      audio,
      settings.enableAnivexa,
    );

    const errors = Array.isArray(response.errors) ? response.errors : [];
    const seen = new Set<string>();
    const streams = (Array.isArray(response.streams) ? response.streams : [])
      .filter((stream) => {
        if (!stream || typeof stream.url !== 'string' || !stream.url) return false;
        if (seen.has(stream.url)) return false;
        seen.add(stream.url);
        return true;
      })
      .map((stream) => ({
        ...stream,
        subtitles:
          stream.subtitles?.length
            ? stream.subtitles
            : response.subtitles ?? [],
      }));

    if (streams.length === 0) {
      return {
        streams: [],
        subtitles: response.subtitles,
        errors: errors.length > 0 ? errors : ['KitaWatch API returned no playable streams.'],
      };
    }

    const value: ResolvedStreams = {
      streams: prioritize(streams),
      subtitles: response.subtitles,
      errors,
    };

    void verifyStreams(value, animeId, episode, audio);
    return value;
  } catch (error) {
    return {
      streams: [],
      errors: [`KitaWatch API: ${errMsg(error)}`],
    };
  }
}

export async function resolveStreams(
  animeId: number | string,
  episode: number,
  audio: AudioType = 'sub',
  title?: string,
  isAdult?: boolean,
): Promise<ResolvedStreams> {
  const key = `${animeId}|${episode}|${audio}|${isAdult === true ? 'a' : 'n'}`;
  const hit = streamCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    const value = hit.value;
    return {
      streams: [...value.streams],
      subtitles: value.subtitles,
      errors: [...value.errors],
      unavailable: value.unavailable,
    };
  }

  const value = await resolveStreamsInner(animeId, episode, audio, title, isAdult);

  // Cache only successful discovery results. Empty results are often transient
  // (providers can time out or recover on a later request); caching them for
  // ten minutes made F5 appear to "fix" playback by clearing the in-memory cache.
  if (value.streams.length > 0) {
    streamCache.set(key, { at: Date.now(), value });
  } else {
    streamCache.delete(key);
  }

  return value;
}
