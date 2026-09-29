import { useEffect, lazy, Suspense } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { AnimatePresence } from 'framer-motion';
import { listen } from '@tauri-apps/api/event';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import { completeLogin, isLoginPending } from '@/services/authFlow';
import { initWindowState } from '@/services/windowState';
import { useUpdater } from '@/hooks/useUpdater';
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

/** kitawatch://auth?code=... — finish the OAuth handshake. */
async function handleAuthUrl(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (url.hostname !== 'auth') return;
  const code = url.searchParams.get('code');
  if (!code) return;

  try {
    await completeLogin(`kitawatch://auth?code=${code}`);
  } catch (e) {
    console.error('[kitawatch] AniList login failed:', e);
  }
}

export default function App() {
  const location = useLocation();
  const { state: updater, install, dismiss } = useUpdater();

  useEffect(() => {
    let disposed = false;
    const cleanups: (() => void)[] = [];

    // Restore saved fullscreen state (no-op outside Tauri).
    void initWindowState();

    import('@tauri-apps/plugin-deep-link')
      .then(async (m) => {
        if (disposed) return;
        const current = await m.getCurrent();
        current?.forEach(handleAuthUrl);
        const un = await m.onOpenUrl((urls) => urls.forEach(handleAuthUrl));
        cleanups.push(un);
      })
      .catch(() => {});

    import('@tauri-apps/api/event')
      .then(async () => {
        if (disposed) return;
        const un = await listen<string[]>('deep-link://new-url', (e) =>
          e.payload?.forEach(handleAuthUrl),
        );
        cleanups.push(un);
      })
      .catch(() => {});

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
            <AnimatePresence mode="wait">
              <Routes location={location} key={location.pathname}>
                <Route path="/" element={<Home />} />
                <Route path="/browse" element={<Browse />} />
                <Route path="/anime/:id" element={<Detail />} />
                <Route path="/watch/:id/:episode" element={<Watch />} />
                <Route path="/my-list" element={<MyList />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/terms" element={<TermsPage />} />
                <Route path="/privacy" element={<PrivacyPage />} />
                <Route path="/dmca" element={<DmcaPage />} />
                <Route path="*" element={<Home />} />
              </Routes>
            </AnimatePresence>
          </Suspense>
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
