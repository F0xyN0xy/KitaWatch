import { useEffect, useState } from 'react';
import { Bug, Github, LogOut, MessageSquareWarning, RefreshCw, Trash2 } from 'lucide-react';
import PageContainer from '@/components/layout/PageContainer';
import Button from '@/components/ui/Button';
import Disclaimer from '@/components/ui/Disclaimer';
import { useSettingsStore, type Quality } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { useAnimeStore } from '@/stores/animeStore';
import { anilist, startAniListOAuth } from '@/services/anilist';
import { completeLogin, markLoginPending, setAuthNotifier } from '@/services/authFlow';
import { getDebugReport } from '@/services/debug';

const QUALITIES: Quality[] = ['auto', '1080p', '720p', '480p'];

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!on)}
      role="switch"
      aria-checked={on}
      className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-accent-600' : 'bg-ink-700'}`}
    >
      <span
        className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`}
      />
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl bg-ink-900 p-5 ring-1 ring-white/5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-widest text-zinc-500">
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

export default function Settings() {
  const {
    defaultQuality,
    autoplayNext,
    setDefaultQuality,
    setAutoplayNext,
    consumetBaseUrl,
    enableConsumetFallback,
    setConsumetBaseUrl,
    setEnableConsumetFallback,
    showAdultContent,
    setShowAdultContent,
  } = useSettingsStore();

  const { accessToken, viewer, clear } = useAuthStore();
  const mergeFavorites = useAnimeStore((s) => s.mergeFavorites);

  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState('');
  const [callbackUrl, setCallbackUrl] = useState('');
  const [consumetUrl, setConsumetUrl] = useState(consumetBaseUrl);
  const [copyingReport, setCopyingReport] = useState(false);

  useEffect(() => setAuthNotifier(setNote), []);

  const flash = (msg: string) => {
    setNote(msg);
    setTimeout(() => setNote(''), 4000);
  };

  const connect = async () => {
    markLoginPending(true);
    setConnecting(true);
    try {
      await startAniListOAuth();
      flash('Browser opened — approve the login there');
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not open the browser');
    } finally {
      setConnecting(false);
    }
  };

  const syncFavorites = async () => {
    if (!accessToken || !viewer) return;
    setSyncing(true);
    try {
      const remote = await anilist.importFavorites(accessToken, viewer.name);
      mergeFavorites(remote);
      flash(`Synced ${remote.length} favorites from AniList`);
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  const copyDebugReport = async () => {
    setCopyingReport(true);
    try {
      const report = await getDebugReport();
      await navigator.clipboard.writeText(report);
      flash('Debug report copied — paste it into your issue');
    } catch (e) {
      flash(e instanceof Error ? e.message : 'Could not collect debug report');
    } finally {
      setCopyingReport(false);
    }
  };

  const clearData = () => {
    if (!window.confirm('Clear all local KitaWatch data (settings, list, login)?')) return;
    localStorage.removeItem('kitawatch-settings');
    localStorage.removeItem('kitawatch-favorites');
    localStorage.removeItem('kitawatch-auth');
    localStorage.removeItem('kitawatch-history');
    location.reload();
  };

  return (
    <PageContainer className="max-w-3xl">
      <h1 className="text-2xl font-bold text-white">Settings</h1>
      {note && (
        <p className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-accent-300 ring-1 ring-accent-500/30">
          {note}
        </p>
      )}

      <Section title="AniList">
        {viewer && accessToken ? (
          <>
            <div className="flex items-center gap-3">
              {viewer.avatar ? (
                <img src={viewer.avatar} alt="" className="h-10 w-10 rounded-full object-cover ring-2 ring-accent-500/40" />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-600 text-sm font-bold text-white">
                  {viewer.name.slice(0, 2).toUpperCase()}
                </span>
              )}
              <div>
                <p className="text-sm font-semibold text-white">{viewer.name}</p>
                <p className="text-xs text-zinc-500">Connected — favorites sync both ways</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={syncFavorites} disabled={syncing}>
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing...' : 'Sync favorites now'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  clear();
                  flash('Disconnected from AniList');
                }}
              >
                <LogOut className="h-3.5 w-3.5" /> Disconnect
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-zinc-400">
              Optional — log in to sync your list with AniList. You log in with
              your own account; everything works fine without it.
            </p>
            <div>
              <Button onClick={connect} disabled={connecting}>
                {connecting ? 'Opening browser...' : 'Connect AniList account'}
              </Button>
            </div>
            <div className="rounded-lg bg-ink-800/60 p-3 ring-1 ring-white/5">
              <p className="mb-2 text-xs text-zinc-500">
                Trouble? After approving in the browser, paste the callback URL
                (<code>kitawatch://auth?code=...</code>) — or the raw token from{' '}
                <code>https://anilist.co/api/v2/oauth/pin</code> — here:
              </p>
              <div className="flex gap-2">
                <input
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  placeholder="kitawatch://auth?code=...  or  token"
                  spellCheck={false}
                  className="flex-1 rounded-lg bg-ink-800 px-3 py-2 text-xs text-zinc-200 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-accent-500/60"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    completeLogin(callbackUrl.trim());
                    setCallbackUrl('');
                  }}
                >
                  Submit
                </Button>
              </div>
            </div>
          </>
        )}
      </Section>

      <Section title="Playback">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-300">Default quality</p>
            <p className="text-xs text-zinc-600">Applied by the player</p>
          </div>
          <select
            value={defaultQuality}
            onChange={(e) => setDefaultQuality(e.target.value as Quality)}
            className="rounded-lg bg-ink-800 px-3 py-2 text-sm text-zinc-200 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-accent-500/60"
          >
            {QUALITIES.map((q) => (
              <option key={q} value={q}>
                {q === 'auto' ? 'Auto' : q}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-300">Auto-play next episode</p>
            <p className="text-xs text-zinc-600">Seamless binge sessions</p>
          </div>
          <Toggle on={autoplayNext} onChange={setAutoplayNext} />
        </div>
      </Section>

      <Section title="Content">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-300">Show adult content (18+)</p>
            <p className="text-xs text-zinc-600">
              Hentai is hidden from search and discovery by default — searching
              for it by name or picking the Hentai genre still shows it
            </p>
          </div>
          <Toggle on={showAdultContent} onChange={setShowAdultContent} />
        </div>
      </Section>

      <Section title="Extra Providers">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-300">Consumet fallback (Gogoanime)</p>
            <p className="text-xs text-zinc-600">
              Independent provider ecosystem, used when Kuhi returns nothing
            </p>
          </div>
          <Toggle on={enableConsumetFallback} onChange={setEnableConsumetFallback} />
        </div>
        <div className="flex gap-2">
          <input
            value={consumetUrl}
            onChange={(e) => setConsumetUrl(e.target.value)}
            spellCheck={false}
            className="flex-1 rounded-lg bg-ink-800 px-3 py-2 text-sm text-zinc-200 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-accent-500/60"
          />
          <Button variant="outline" size="sm" onClick={() => { setConsumetBaseUrl(consumetUrl.trim()); flash('Saved'); }}>
            Save
          </Button>
        </div>
        <p className="text-xs text-zinc-600">
          Run it with: <code className="text-zinc-400">docker run -p 3000:3000 riimuru/consumet-api</code>
        </p>
      </Section>

      <Section title="Troubleshooting">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-300">Copy debug report</p>
            <p className="text-xs text-zinc-600">
              Sidecar status, port probes and recent logs — paste it into a bug report
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={copyDebugReport} disabled={copyingReport}>
            <Bug className="h-3.5 w-3.5" /> {copyingReport ? 'Collecting...' : 'Copy report'}
          </Button>
        </div>
        <p className="text-xs text-zinc-600">
          Logs live in <code className="text-zinc-400">%APPDATA%\KitaWatch\logs</code>. Launch
          the app with <code className="text-zinc-400">--debug</code> to keep sidecar windows
          visible and raise log verbosity.
        </p>
      </Section>

      <Section title="Data">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-300">Clear local data</p>
            <p className="text-xs text-zinc-600">
              Settings, My List, history and the AniList login token
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={clearData}>
            <Trash2 className="h-3.5 w-3.5" /> Clear
          </Button>
        </div>
      </Section>

      <Section title="About">
        <p className="text-sm text-zinc-400">KitaWatch v0.7.1</p>
        <div className="flex flex-wrap gap-2">
          <a
            href="https://github.com/F0xyN0xy/KitaWatch/issues"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-800 px-3 py-1.5 text-xs text-zinc-300 ring-1 ring-white/10 transition hover:text-white hover:ring-accent-500/50"
          >
            <MessageSquareWarning className="h-3.5 w-3.5" /> Report a bug / Idea
          </a>
          <a
            href="https://github.com/F0xyN0xy/KitaWatch"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg bg-ink-800 px-3 py-1.5 text-xs text-zinc-300 ring-1 ring-white/10 transition hover:text-white hover:ring-accent-500/50"
          >
            <Github className="h-3.5 w-3.5" /> GitHub
          </a>
        </div>
        <Disclaimer />
      </Section>
    </PageContainer>
  );
}