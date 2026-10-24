import { useEffect, useState, lazy, Suspense } from 'react';
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { listen } from '@tauri-apps/api/event';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import { completeLogin, isLoginPending } from '@/services/authFlow';
import { completeDiscordOAuth } from '@/services/discordAuth';
import { initWindowState } from '@/services/windowState';
import { useUpdater } from '@/hooks/useUpdater';
import { useSettingsStore } from '@/stores/settingsStore';
import { Download, X } from 'lucide-react';

// Route-level code splitting: each page is its own chunk, loaded on demand.
const Home = lazy(() => import('@/pages/Home'));
const Browse = lazy(() => import('@/pages/Browse'));
const Detail = lazy(() => import('@/pages/Detail'));
const Watch = lazy(() => import('@/pages/Watch'));
const MyList = lazy(() => import('@/pages/MyList'));
const Settings = lazy(() => import('@/pages/Settings'));
const TermsPage = lazy(() => import('@/pages/Legal').then((m) => ({ default: m.TermsPage })));
const PrivacyPage = lazy(() => import('@/pages/Legal').then((m) => ({ default: m.PrivacyPage })));
const DmcaPage = lazy(() => import('@/pages/Legal').then((m) => ({ default: m.DmcaPage })));

/** Prevent the native and plugin listeners from exchanging the same one-time code twice. */
const processedAuthCodes = new Set<string>();

/** kitawatch://auth?code=... — finish the OAuth handshake. Never log callback URLs or codes. */
async function handleAuthUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    console.warn('[kitawatch][oauth] Ignored an invalid deep-link URL.');
    return;
  }

  const provider = url.searchParams.get('provider');
  const hasCode = Boolean(url.searchParams.get('code'));
  console.info('[kitawatch][oauth] Deep-link received', {
    protocol: url.protocol,
    host: url.hostname,
    provider: provider ?? '(missing)',
    hasCode,
    queryKeys: Array.from(url.searchParams.keys()),
  });

  if (url.protocol !== 'kitawatch:' || url.hostname !== 'auth') {
    console.warn('[kitawatch][oauth] Ignored a deep link with an unexpected scheme or host.');
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    console.warn('[kitawatch][oauth] Callback has no authorization code.');
    return;
  }

  if (processedAuthCodes.has(code)) {
    console.info('[kitawatch][oauth] Ignored a duplicate callback code.');
    return;
  }
  processedAuthCodes.add(code);

  try {
    if (provider === 'discord') {
      console.info('[kitawatch][oauth] Starting Discord code exchange.');
      const completed = await completeDiscordOAuth(rawUrl);
      console.info('[kitawatch][oauth] Discord code exchange finished', { completed });
      if (!completed) {
        console.warn('[kitawatch][oauth] Discord callback parser rejected the callback.');
      }
      return;
    }
    console.info('[kitawatch][oauth] Starting AniList code exchange.');
    await completeLogin(`kitawatch://auth?code=${code}`);
    console.info('[kitawatch][oauth] AniList code exchange finished.');
  } catch (error) {
    // Permit a retry if the exchange failed; successful one-time codes stay deduplicated.
    processedAuthCodes.delete(code);
    // Log the error type only: provider errors can contain sensitive callback data.
    console.error(
      provider === 'discord'
        ? '[kitawatch][oauth] Discord code exchange failed.'
        : '[kitawatch][oauth] AniList code exchange failed.',
      { errorType: error instanceof Error ? error.name : typeof error },
    );
  }
}

export default function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const themeAccent = useSettingsStore((state) => state.themeAccent);

  useEffect(() => {
    document.documentElement.dataset.themeAccent = themeAccent;
  }, [themeAccent]);
  const watchMatch = location.pathname.match(/^\/watch\/([^/]+)\/([^/]+)\/?$/);
  const currentWatchRoute = watchMatch ? { id: watchMatch[1], episode: watchMatch[2] } : null;
  const [lastWatchRoute, setLastWatchRoute] = useState<{ id: string; episode: string } | null>(null);
  const [playerDismissed, setPlayerDismissed] = useState(false);
  const isWatchRoute = currentWatchRoute !== null;
  const playerRoute = currentWatchRoute ?? (playerDismissed ? null : lastWatchRoute);

  useEffect(() => {
    if (currentWatchRoute) {
      setLastWatchRoute(currentWatchRoute);
      setPlayerDismissed(false);
    }
  }, [location.pathname]);

  const { state: updater, install, dismiss } = useUpdater();

  // Measure the shared shell during development without adding production console noise.
  useEffect(() => {
    if (import.meta.env.DEV && typeof performance !== 'undefined') {
      performance.mark('kitawatch:app-shell-committed');
      const navigationStart = performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
      console.debug(
        `[kitawatch][startup-timing] React app shell committed in ${(performance.now() - navigationStart).toFixed(1)}ms`,
      );
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];

    // Restore saved fullscreen state (no-op outside Tauri).
    void initWindowState();

    console.info('[kitawatch][oauth] Initializing deep-link listeners.');
    import('@tauri-apps/plugin-deep-link')
      .then(async (m) => {
        if (disposed) return;
        const current = await m.getCurrent();
        console.info('[kitawatch][oauth] Startup deep-link lookup finished', {
          hasCurrentUrl: Boolean(current?.length),
          urlCount: current?.length ?? 0,
        });
        current?.forEach((url) => void handleAuthUrl(url));
        const un = await m.onOpenUrl((urls) => {
          console.info('[kitawatch][oauth] Deep-link plugin event received', { urlCount: urls.length });
          urls.forEach((url) => void handleAuthUrl(url));
        });
        cleanups.push(un);
        console.info('[kitawatch][oauth] Deep-link plugin listener registered.');
      })
      .catch((error) => {
        console.error('[kitawatch][oauth] Deep-link plugin initialization failed.', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      });

    import('@tauri-apps/api/event')
      .then(async () => {
        if (disposed) return;
        const un = await listen<string[]>('deep-link://new-url', (e) => {
          console.info('[kitawatch][oauth] Native deep-link event received', {
            urlCount: e.payload?.length ?? 0,
          });
          e.payload?.forEach((url) => void handleAuthUrl(url));
        });
        cleanups.push(un);
        console.info('[kitawatch][oauth] Native deep-link event listener registered.');
      })
      .catch((error) => {
        console.error('[kitawatch][oauth] Native event listener registration failed.', {
          errorType: error instanceof Error ? error.name : typeof error,
        });
      });

    const poll = setInterval(() => {
      if (!isLoginPending() || disposed) return;
      import('@tauri-apps/plugin-deep-link')
        .then((m) => m.getCurrent())
        .then((urls) => urls?.forEach(handleAuthUrl))
        .catch(() => {});
    }, 2000);
    cleanups.push(() => clearInterval(poll));

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
    };
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-ink-950 text-zinc-200">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <ErrorBoundary>
          <Suspense
            fallback={
              <div className="grid flex-1 place-items-center text-sm text-zinc-600">
                Loading…
              </div>
            }
          >
            <Routes location={location} key={location.pathname}>
                <Route path="/" element={<Home />} />
                <Route path="/browse" element={<Browse />} />
                <Route path="/anime/:id" element={<Detail />} />
                <Route path="/watch/:id/:episode" element={<div />} />
                <Route path="/my-list" element={<MyList />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/terms" element={<TermsPage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/dmca" element={<DmcaPage />} />
                <Route path="*" element={<Home />} />
            </Routes>
          </Suspense>
          {playerRoute && (
            <Suspense fallback={null}>
              <div
                className={
                  isWatchRoute
                    ? 'relative flex min-h-0 flex-1 flex-col'
                    : 'fixed bottom-4 right-4 z-40 flex max-h-[min(460px,calc(100vh-2rem))] w-[min(420px,calc(100vw-2rem))] flex-col overflow-y-auto rounded-xl bg-ink-950 shadow-2xl ring-1 ring-white/15'
                }
              >
                <div className={isWatchRoute ? 'hidden' : 'sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-ink-900 px-3 py-2'}>
                  <span className="truncate text-xs font-semibold text-zinc-200">Playing in mini-player</span>
                  <div className="flex shrink-0 items-center gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/watch/${playerRoute.id}/${playerRoute.episode}`)}
                      className="rounded-md bg-accent-600 px-2 py-1 text-xs font-medium text-white hover:bg-accent-500"
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      onClick={() => setPlayerDismissed(true)}
                      aria-label="Close mini-player and stop playback"
                      title="Close mini-player and stop playback"
                      className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-white/10 hover:text-white"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>
                <Watch id={playerRoute.id} episode={playerRoute.episode} />
              </div>
            </Suspense>
          )}
        </ErrorBoundary>
      </div>
      {/* Update banner */}
      {(updater.kind === 'available' || updater.kind === 'installing' || updater.kind === 'installed') && (
        <div className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-xl bg-ink-850 px-4 py-3 shadow-2xl ring-1 ring-accent-500/40">
          {updater.kind === 'installed' ? (
            <p className="text-sm text-zinc-200">
              Update installed — restart KitaWatch to finish.
            </p>
          ) : (
            <>
              <Download className="h-4 w-4 text-accent-400" />
              <p className="text-sm text-zinc-200">
                {updater.kind === 'available'
                  ? `KitaWatch v${updater.update.version} is available`
                  : 'Downloading update…'}
              </p>
              {updater.kind === 'available' && (
                <button
                  onClick={install}
                  className="rounded-lg bg-accent-600 px-3 py-1 text-xs font-medium text-white hover:bg-accent-500"
                >
                  Update
                </button>
              )}
            </>
          )}
          <button onClick={dismiss} aria-label="Dismiss" className="text-zinc-500 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
