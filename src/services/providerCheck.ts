import { api } from './api';
import { useSettingsStore } from '@/stores/settingsStore';

export interface ProviderStatus {
  name: string;
  status: 'ok' | 'empty' | 'error';
  detail: string;
}

/** Probe playback providers through the KitaWatch API, never from the WebView. */
export async function checkProviders(
  animeId: number | string,
  _title: string,
  episode = 1,
): Promise<ProviderStatus[]> {
  const settings = useSettingsStore.getState();
  let response;
  try {
    response = await api.watch(animeId, episode, 'sub', settings.enableAnivexa);
  } catch (error) {
    return [{
      name: 'KitaWatch API',
      status: 'error',
      detail: error instanceof Error ? error.message : 'Provider check failed',
    }];
  }
  const statuses: ProviderStatus[] = [];
  const providers = response.providers ?? {};

  const kuhi = providers.kuhi as
    | { status?: string; streamCount?: number; provider?: string; error?: string }
    | undefined;
  if (kuhi) {
    statuses.push({
      name: 'Kuhi (native race)',
      status: kuhi.status === 'success' ? 'ok' : kuhi.status === 'error' ? 'error' : 'empty',
      detail: kuhi.error
        ? kuhi.error
        : kuhi.streamCount
          ? `${kuhi.streamCount} stream(s)${kuhi.provider ? ` via ${kuhi.provider}` : ''} for ep ${episode}`
          : 'no streams returned',
    });
  }

  const anivexa = providers.anivexa;
  if (anivexa && typeof anivexa === 'object') {
    for (const [provider, raw] of Object.entries(anivexa as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue;
      const result = raw as { status?: string; streamCount?: number; error?: string };
      statuses.push({
        name: `Anivexa: ${provider}`,
        status: result.status === 'success' ? 'ok' : result.status === 'error' ? 'error' : 'empty',
        detail: result.error ?? `${result.streamCount ?? 0} playable stream(s)`,
      });
    }
  }

  if (statuses.length === 0) {
    return [{
      name: 'KitaWatch API',
      status: 'empty',
      detail: response.errors?.join('; ') || 'No provider diagnostics were returned.',
    }];
  }

  return statuses;
}
