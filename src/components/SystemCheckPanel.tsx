import { useCallback, useEffect, useState } from 'react';
import { Activity, CheckCircle2, CircleAlert, CircleX, RefreshCw, Wrench } from 'lucide-react';
import Button from '@/components/ui/Button';
import { api } from '@/services/api';
import { useSettingsStore } from '@/stores/settingsStore';

type Status = 'checking' | 'pass' | 'warning' | 'fail';
type Check = {
  id: string;
  label: string;
  detail: string;
  status: Status;
  fix?: string;
};

function platformCheck(): Check {
  const ua = navigator.userAgent;
  const platform = navigator.platform || 'Unknown platform';
  const isDesktopOS = /Windows|Win32|Linux|Macintosh|MacIntel/i.test(`${ua} ${platform}`);
  return {
    id: 'os',
    label: 'Operating system',
    detail: `${platform} · ${isDesktopOS ? 'desktop platform detected' : 'platform not recognized'}`,
    status: isDesktopOS ? 'pass' : 'warning',
    fix: isDesktopOS ? undefined : 'KitaWatch is primarily tested on Windows and desktop Linux. Some features may differ on this platform.',
  };
}

function StatusIcon({ status }: { status: Status }) {
  if (status === 'checking') return <Activity className="h-4 w-4 animate-pulse text-amber-300" />;
  if (status === 'pass') return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
  if (status === 'warning') return <CircleAlert className="h-4 w-4 text-amber-300" />;
  return <CircleX className="h-4 w-4 text-rose-400" />;
}

export default function SystemCheckPanel() {
  const proxyBaseUrl = useSettingsStore((s) => s.proxyBaseUrl);
  const [checks, setChecks] = useState<Check[]>([]);
  const [running, setRunning] = useState(false);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const runChecks = useCallback(async () => {
    setRunning(true);
    setChecks([
      platformCheck(),
      { id: 'api', label: 'Local API / metadata', detail: 'Checking the local API status endpoint…', status: 'checking' },
      { id: 'proxy', label: 'Playback proxy', detail: 'Checking the local proxy service…', status: 'checking' },
    ]);

    const os = platformCheck();
    const results = await Promise.allSettled([
      api.providersStatus(),
      fetch(`${proxyBaseUrl.replace(/\/$/, '')}/openapi.json`, { signal: AbortSignal.timeout(5000) }),
    ]);

    const apiResult = results[0];
    const proxyResult = results[1];
    const next: Check[] = [os];

    if (apiResult.status === 'fulfilled') {
      next.push({
        id: 'api',
        label: 'Local API / metadata',
        detail: 'The API status endpoint responded. Metadata requests can be attempted.',
        status: 'pass',
      });
    } else {
      next.push({
        id: 'api',
        label: 'Local API / metadata',
        detail: apiResult.reason instanceof Error ? apiResult.reason.message : 'The API status request failed.',
        status: 'fail',
        fix: 'Restart KitaWatch so its local API sidecar can start. If this persists, use Copy debug report in Troubleshooting.',
      });
    }

    if (proxyResult.status === 'fulfilled' && proxyResult.value.ok) {
      next.push({
        id: 'proxy',
        label: 'Playback proxy',
        detail: 'The local proxy responded to its OpenAPI endpoint.',
        status: 'pass',
      });
    } else {
      const detail = proxyResult.status === 'rejected'
        ? (proxyResult.reason instanceof Error ? proxyResult.reason.message : 'The proxy request failed.')
        : `Proxy returned HTTP ${proxyResult.value.status}.`;
      next.push({
        id: 'proxy',
        label: 'Playback proxy',
        detail,
        status: 'fail',
        fix: 'Restart KitaWatch and check that the local proxy on port 8001 starts. Use Copy debug report for sidecar and port diagnostics.',
      });
    }

    setChecks(next);
    setCheckedAt(Date.now());
    setRunning(false);
  }, [proxyBaseUrl]);

  useEffect(() => {
    void runChecks();
  }, [runChecks]);

  const failures = checks.filter((check) => check.status === 'fail').length;
  const warnings = checks.filter((check) => check.status === 'warning').length;

  return (
    <section className="rounded-xl bg-ink-900 p-4 ring-1 ring-white/5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">System Check</h2>
          <p className="text-sm text-zinc-300">
            {running ? 'Checking local services…' : failures ? `${failures} check(s) need attention` : warnings ? 'Checks completed with a warning' : 'Local service checks completed'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void runChecks()} disabled={running}>
          <RefreshCw className={`h-3.5 w-3.5 ${running ? 'animate-spin' : ''}`} />
          {running ? 'Checking…' : 'Run again'}
        </Button>
      </div>

      <div className="mt-4 space-y-3">
        {checks.map((check) => (
          <div key={check.id} className="flex items-start gap-3">
            <StatusIcon status={check.status} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-zinc-200">{check.label}</p>
              <p className="mt-0.5 break-words text-xs text-zinc-500">{check.detail}</p>
              {check.fix && (
                <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-200/90">
                  <Wrench className="mt-0.5 h-3 w-3 shrink-0" />
                  <span>Suggested fix: {check.fix}</span>
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      <p className="mt-4 text-xs text-zinc-600">
        {checkedAt ? `Last checked ${new Date(checkedAt).toLocaleTimeString()} · ` : ''}
        A passing connection check confirms the endpoint responded; it does not guarantee every provider or episode is playable.
      </p>
    </section>
  );
}
