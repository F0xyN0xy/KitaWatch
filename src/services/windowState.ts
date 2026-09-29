import { useSettingsStore } from '@/stores/settingsStore';

/**
 * Fullscreen persistence, Rust-side (window-state.json in the app config
 * dir). The webview only has to (1) tell Rust whether to remember, and
 * (2) ask it to re-apply the saved state at startup. No-ops outside Tauri.
 */

async function invokeSafe<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke(cmd, args)) as T;
  } catch {
    return null; // browser dev / unavailable — persistence stays off
  }
}

/** Startup: sync the "remember" pref and restore the saved fullscreen state. */
export async function initWindowState(): Promise<void> {
  const { rememberFullscreen } = useSettingsStore.getState();
  await invokeSafe('set_fullscreen_remember', { enabled: rememberFullscreen });
  await invokeSafe('apply_saved_fullscreen');
}

/** Keep Rust's pref in sync when the user flips the Settings toggle. */
export function setFullscreenRemember(enabled: boolean): void {
  void invokeSafe('set_fullscreen_remember', { enabled });
}
