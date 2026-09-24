import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Quality = 'auto' | '1080p' | '720p' | '480p';

/** Provider order for the source list (prefix match on the "server" tag). */
export const PROVIDER_PRIORITY = [
  // Kuhi native + Anivexa providers (server tags are the bare provider name)
  'anizone',
  'anineko',
  'anikoto',
  'reanime',
  'aniwaves',
  'kaa',
  'anibd',
  'animegg',
  'mkissa',
  'animeonsen',
  // standalone providers
  'anify',
  'anikage',
  '1anime',
  'consumet',
  'animepahe',
] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false;
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The Anivexa and proxy sidecars are bundled with the app and always local.
 * Old releases were built with VITE_* env vars pointing at a hosted API
 * (*.kitawatch.nx.kg) that no longer exists; those URLs were persisted into
 * users' localStorage and poisoned every provider call with DNS failures.
 * Only loopback URLs are ever valid for these two settings — a remote or
 * dead value is silently replaced by the local default.
 */
function sidecarDefault(env: unknown, fallback: string): string {
  return isLoopbackUrl(env) ? (env as string) : fallback;
}

interface SettingsState {
  defaultQuality: Quality;
  autoplayNext: boolean;
  providerPriority: string[];
  consumetBaseUrl: string;
  enableConsumetFallback: boolean;
  /** Local proxy sidecar (CORS + referer + m3u8 rewrite). */
  proxyBaseUrl: string;
  /** Bundled Anivexa sidecar (Node, by-AniList-ID provider aggregator). */
  anivexaBaseUrl: string;
  enableAnivexa: boolean;
  /** #4: remember fullscreen state and restore it on the next playback. */
  rememberFullscreen: boolean;
  /** #4: last fullscreen state (internal, persisted). */
  lastFullscreen: boolean;
  /**
   * Show hentai in search and discovery lists. Default off — see
   * adultContentAllowed() in services/api.ts for the override rules
   * (explicit name/genre searches always get through).
   */
  showAdultContent: boolean;
  setDefaultQuality: (q: Quality) => void;
  setAutoplayNext: (v: boolean) => void;
  setProviderPriority: (order: string[]) => void;
  setConsumetBaseUrl: (url: string) => void;
  setEnableConsumetFallback: (v: boolean) => void;
  setProxyBaseUrl: (url: string) => void;
  setAnivexaBaseUrl: (url: string) => void;
  setEnableAnivexa: (v: boolean) => void;
  setRememberFullscreen: (v: boolean) => void;
  setLastFullscreen: (v: boolean) => void;
  setShowAdultContent: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultQuality: 'auto',
      autoplayNext: true,
      providerPriority: [...PROVIDER_PRIORITY],
      // Consumet is user-self-hostable (docker) and NOT bundled with the app,
      // so the fallback is opt-in — enabling it without a local instance
      // just adds a guaranteed connection-refused to every episode.
      consumetBaseUrl: import.meta.env.VITE_CONSUMET_BASE_URL ?? 'http://localhost:3000',
      enableConsumetFallback: false,
      proxyBaseUrl: sidecarDefault(import.meta.env.VITE_PROXY_BASE_URL, 'http://localhost:8001'),
      anivexaBaseUrl: sidecarDefault(import.meta.env.VITE_ANIVEXA_BASE_URL, 'http://localhost:4000'),
      enableAnivexa: true,
      rememberFullscreen: true,
      lastFullscreen: false,
      showAdultContent: false,
      setDefaultQuality: (defaultQuality) => set({ defaultQuality }),
      setAutoplayNext: (autoplayNext) => set({ autoplayNext }),
      setProviderPriority: (providerPriority) => set({ providerPriority }),
      setConsumetBaseUrl: (consumetBaseUrl) => set({ consumetBaseUrl }),
      setEnableConsumetFallback: (enableConsumetFallback) =>
        set({ enableConsumetFallback }),
      setProxyBaseUrl: (proxyBaseUrl) => set({ proxyBaseUrl }),
      setAnivexaBaseUrl: (anivexaBaseUrl) => set({ anivexaBaseUrl }),
      setEnableAnivexa: (enableAnivexa) => set({ enableAnivexa }),
      setRememberFullscreen: (rememberFullscreen) => set({ rememberFullscreen }),
      setLastFullscreen: (lastFullscreen) => set({ lastFullscreen }),
      setShowAdultContent: (showAdultContent) => set({ showAdultContent }),
    }),
    {
      name: 'kitawatch-settings',
      version: 4,
      migrate: (persisted, version) => {
        const s = { ...((persisted as Partial<SettingsState>) ?? {}) };
        if (version < 2) {
          // v1 persisted whatever the build-time defaults were — including
          // the dead hosted-API URLs from old releases. Force loopback.
          if (!isLoopbackUrl(s.anivexaBaseUrl)) s.anivexaBaseUrl = 'http://localhost:4000';
          if (!isLoopbackUrl(s.proxyBaseUrl)) s.proxyBaseUrl = 'http://localhost:8001';
        }
        if (version < 3) {
          // v2 still trusted the hosted Consumet default: old releases
          // pointed it at api.kitawatch.nx.kg, which no longer resolves.
          // Remote self-hosted Consumet stays allowed — only the dead
          // hosted domain is reset.
          if (
            typeof s.consumetBaseUrl !== 'string' ||
            s.consumetBaseUrl.includes('kitawatch.free.nf')
          ) {
            s.consumetBaseUrl = 'http://localhost:3000';
          }
        }
        // v4 introduced the adult-content filter (showAdultContent). The
        // key is absent in older persisted states, so it falls through to
        // the false default above — upgrades get the safe default too.
        // Nothing to rewrite here.
        return s as SettingsState;
      },
    },
  ),
);