import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, RefreshCw, XCircle } from 'lucide-react';
import Button from '@/components/ui/Button';
import { api } from '@/services/api';
import type { ProviderStatus as ProviderStatusData } from '@/types';

type CheckState = 'checking' | 'available' | 'unavailable';

function formatLatency(seconds?: number): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds < 1 ? `${Math.round(seconds * 1000)} ms` : `${seconds.toFixed(2)} s`;
}

export default function ProviderStatusPanel() {
  const [state, setState] = useState<CheckState>('checking');
  const [data, setData] = useState<ProviderStatusData | null>(null);
  const [error, setError] = useState('');
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setState('checking');
    setError('');
    try {
      const result = await api.providersStatus();
      setData(result);
      setState('available');
      setCheckedAt(Date.now());
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : 'Could not reach the Kuhi API');
      setState('unavailable');
      setCheckedAt(Date.now());
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const available = new Set(data?.available ?? []);
  const providerNames = [...new Set([...(data?.ranking ?? []), ...(data?.available ?? [])])];
  const statusIcon =
    state === 'checking' ? (
      <Activity className="h-4 w-4 animate-pulse text-amber-300" />
    ) : state === 'available' ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
    ) : (
      <XCircle className="h-4 w-4 text-rose-400" />
    );

  return (
    <section className="rounded-2xl bg-ink-900 p-5 ring-1 ring-white/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-widest text-zinc-500">
            Provider Status
          </h2>
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            {statusIcon}
            {state === 'checking'
              ? 'Checking Kuhi API…'
              : state === 'available'
                ? 'Kuhi API reachable'
                : 'Kuhi API unavailable'}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={state === 'checking'}>
          <RefreshCw className={`h-3.5 w-3.5 ${state === 'checking' ? 'animate-spin' : ''}`} />
          {state === 'checking' ? 'Checking…' : 'Refresh'}
        </Button>
      </div>

      {state === 'unavailable' && (
        <p role="status" className="mt-3 text-xs text-rose-300">
          {error || 'The status request failed.'}
        </p>
      )}

      {state === 'available' && providerNames.length > 0 && (
        <ul className="mt-4 space-y-2">
          {providerNames.map((name) => {
            const isAvailable = available.has(name);
            const latency = formatLatency(data?.latency?.[name]?.avg_seconds);
            const failures = data?.latency?.[name]?.failures;
            return (
              <li key={name} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-2 text-zinc-300">
                  {isAvailable ? (
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  ) : (
                    <XCircle className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  )}
                  <span className="truncate">{name}</span>
                  {name === data?.defaultProvider && (
                    <span className="rounded-full bg-accent-600/15 px-2 py-0.5 text-[10px] text-accent-300">
                      Default
                    </span>
                  )}
                </span>
                <span className="text-xs text-zinc-500">
                  {isAvailable ? 'Reported available' : 'Not reported available'}
                  {latency ? ` · avg ${latency}` : ''}
                  {typeof failures === 'number' ? ` · ${failures} failures` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {state === 'available' && providerNames.length === 0 && (
        <p className="mt-3 text-xs text-zinc-500">
          The Kuhi API responded, but it did not return a provider list.
        </p>
      )}

      <p className="mt-4 text-xs text-zinc-600">
        {checkedAt ? `Last checked ${new Date(checkedAt).toLocaleTimeString()} · ` : ''}
        These are the providers reported by Kuhi’s status endpoint, not a guarantee that every anime or episode will play.
      </p>
    </section>
  );
}
