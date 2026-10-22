import { isTauri } from '@tauri-apps/api/core';
import { getAllWebviewWindows } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './styles/globals.css';

const currentTauriWindow = isTauri() ? getCurrentWindow() : null;
const isMainWindow = !currentTauriWindow || currentTauriWindow.label === 'main';

if (import.meta.env.DEV && typeof performance !== 'undefined') {
  performance.mark('kitawatch:frontend-entry');
  const navigationStart = performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
  console.debug(
    `[kitawatch][startup-timing] frontend entry reached in ${(performance.now() - navigationStart).toFixed(1)}ms`,
  );
}

// Register before React renders so the first committed app shell can trigger
// the native splash handoff. Do not reveal the main window on a timer: on slower
// machines that can expose about:blank before React has committed any UI.
if (currentTauriWindow?.label === 'main') {
  const onAppReady = async () => {
    window.removeEventListener('kitawatch:app-ready', onAppReady);
    try {
      if (import.meta.env.DEV && typeof performance !== 'undefined') {
        performance.mark('kitawatch:show-main-window');
        const navigationStart = performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
        console.debug(
          `[kitawatch][startup-timing] main window shown after ${(performance.now() - navigationStart).toFixed(1)}ms`,
        );
      }
      await currentTauriWindow.show();
      const splash = (await getAllWebviewWindows()).find((window) => window.label === 'splashscreen');
      if (splash) await splash.close();
    } catch (error) {
      console.error('[kitawatch][startup] Could not complete splash handoff.', error);
    }
  };
  window.addEventListener('kitawatch:app-ready', onAppReady);
}

if (isMainWindow) {
  if (import.meta.env.DEV && typeof performance !== 'undefined') {
    performance.mark('kitawatch:react-root-render-start');
  }
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}

if (import.meta.env.DEV && typeof performance !== 'undefined') {
  performance.mark('kitawatch:react-entry');
  const navigationStart = performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
  const entryTime = performance.now() - navigationStart;
  console.debug(`[kitawatch][startup-timing] frontend entry reached in ${entryTime.toFixed(1)}ms`);
}

if (currentTauriWindow?.label === 'main') {
  // The native splash is a separate, lightweight window. Keep it visible while
  // React and its initial route initialize in the hidden main window.
  requestAnimationFrame(() => {
    requestAnimationFrame(async () => {
      try {
        await currentTauriWindow.show();
        const splash = (await getAllWebviewWindows()).find((window) => window.label === 'splashscreen');
        if (splash) await splash.close();
      } catch (error) {
        console.error('[kitawatch][startup] Could not complete splash handoff.', error);
      }
    });
  });
}

if (import.meta.env.DEV && typeof performance !== 'undefined') {
  // React commits asynchronously; double RAF gives the initial render a chance
  // to reach the browser's paint pipeline before reporting an approximate time.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      const navigationStart = performance.getEntriesByType('navigation')[0]?.startTime ?? 0;
      console.debug(
        `[kitawatch][startup-timing] first render frame reached in ${(performance.now() - navigationStart).toFixed(1)}ms`,
      );
    });
  });
}
