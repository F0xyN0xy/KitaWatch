import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Quality = 'auto' | '1080p' | '720p' | '480p';

/** Provider order for the source list (prefix match on the "server" tag). */
export const PROVIDER_PRIORITY = [
  'anizone', 'anineko', 'anikoto', 'reanime', 'aniwaves', 'kaa', 'anibd', 'animegg', 'mkissa', 'animeonsen',
  'anidbapp', '2dhive', 'animenosub', 'senshi', 'animedunya', 'anify', 'anikage', '1anime', 'consumet', 'animepahe',
] as const;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
function isLoopbackUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url) return false;
  try { return LOOPBACK_HOSTS.has(new URL(url).hostname); } catch { return false; }
}
function sidecarDefault(env: unknown, fallback: string): string {
  return isLoopbackUrl(env) ? (env as string) : fallback;
}

interface SettingsState {
  defaultQuality: Quality;
  autoplayNext: boolean;
  subtitleEnabled: boolean;
  subtitleFontSize: number;
  subtitleColor: string;
  providerPriority: string[];
  preferredSubProvider: string;
  preferredDubProvider: string;
  consumetBaseUrl: string;
  enableConsumetFallback: boolean;
  proxyBaseUrl: string;
  anivexaBaseUrl: string;
  enableAnivexa: boolean;
  rememberFullscreen: boolean;
  lastFullscreen: boolean;
  showAdultContent: boolean;
  updateAdultProgress: boolean;
  adultProvidersUnavailable: boolean;
  discordRichPresence: boolean;
  discordAppId: string;
  setDefaultQuality: (q: Quality) => void;
  setAutoplayNext: (v: boolean) => void;
  setSubtitleEnabled: (v: boolean) => void;
  setSubtitleFontSize: (v: number) => void;
  setSubtitleColor: (v: string) => void;
  setProviderPriority: (order: string[]) => void;
  setPreferredSubProvider: (provider: string) => void;
  setPreferredDubProvider: (provider: string) => void;
  setConsumetBaseUrl: (url: string) => void;
  setEnableConsumetFallback: (v: boolean) => void;
  setProxyBaseUrl: (url: string) => void;
  setAnivexaBaseUrl: (url: string) => void;
  setEnableAnivexa: (v: boolean) => void;
  setRememberFullscreen: (v: boolean) => void;
  setLastFullscreen: (v: boolean) => void;
  setShowAdultContent: (v: boolean) => void;
  setUpdateAdultProgress: (v: boolean) => void;
  setAdultProvidersUnavailable: (v: boolean) => void;
  setDiscordRichPresence: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      defaultQuality: 'auto',
      autoplayNext: true,
      subtitleEnabled: true,
      subtitleFontSize: 24,
      subtitleColor: '#ffffff',
      providerPriority: [...PROVIDER_PRIORITY],
      preferredSubProvider: '',
      preferredDubProvider: '',
      consumetBaseUrl: import.meta.env.VITE_CONSUMET_BASE_URL ?? 'http://localhost:3000',
      enableConsumetFallback: false,
      proxyBaseUrl: sidecarDefault(import.meta.env.VITE_PROXY_BASE_URL, 'http://localhost:8001'),
      anivexaBaseUrl: sidecarDefault(import.meta.env.VITE_ANIVEXA_BASE_URL, 'http://localhost:4000'),
      enableAnivexa: true,
      rememberFullscreen: true,
      lastFullscreen: false,
      showAdultContent: false,
      updateAdultProgress: false,
      adultProvidersUnavailable: true,
      discordRichPresence: true,
      discordAppId: '1553307716758536202',
      setDefaultQuality: (defaultQuality) => set({ defaultQuality }),
      setAutoplayNext: (autoplayNext) => set({ autoplayNext }),
      setSubtitleEnabled: (subtitleEnabled) => set({ subtitleEnabled }),
      setSubtitleFontSize: (subtitleFontSize) => set({ subtitleFontSize: Math.min(40, Math.max(14, Math.round(subtitleFontSize))) }),
      setSubtitleColor: (subtitleColor) => set({ subtitleColor }),
      setProviderPriority: (providerPriority) => set({ providerPriority }),
      setPreferredSubProvider: (preferredSubProvider) => set({ preferredSubProvider }),
      setPreferredDubProvider: (preferredDubProvider) => set({ preferredDubProvider }),
      setConsumetBaseUrl: (consumetBaseUrl) => set({ consumetBaseUrl }),
      setEnableConsumetFallback: (enableConsumetFallback) => set({ enableConsumetFallback }),
      setProxyBaseUrl: (proxyBaseUrl) => set({ proxyBaseUrl }),
      setAnivexaBaseUrl: (anivexaBaseUrl) => set({ anivexaBaseUrl }),
      setEnableAnivexa: (enableAnivexa) => set({ enableAnivexa }),
      setRememberFullscreen: (rememberFullscreen) => set({ rememberFullscreen }),
      setLastFullscreen: (lastFullscreen) => set({ lastFullscreen }),
      setShowAdultContent: (showAdultContent) => set({ showAdultContent }),
      setUpdateAdultProgress: (updateAdultProgress) => set({ updateAdultProgress }),
      setAdultProvidersUnavailable: (adultProvidersUnavailable) => set({ adultProvidersUnavailable }),
      setDiscordRichPresence: (discordRichPresence) => set({ discordRichPresence }),
    }),
    {
      name: 'kitawatch-settings',
      version: 9,
      migrate: (persisted, version) => {
        const s = { ...((persisted as Partial<SettingsState>) ?? {}) };
        if (version < 2) {
          if (!isLoopbackUrl(s.anivexaBaseUrl)) s.anivexaBaseUrl = 'http://localhost:4000';
          if (!isLoopbackUrl(s.proxyBaseUrl)) s.proxyBaseUrl = 'http://localhost:8001';
        }
        if (version < 3 && (typeof s.consumetBaseUrl !== 'string' || s.consumetBaseUrl.includes('kitawatch.free.nf'))) {
          s.consumetBaseUrl = 'http://localhost:3000';
        }
        if (version < 5) {
          if (!s.discordAppId) s.discordAppId = '1553307716758536202';
          if (s.discordRichPresence == null) s.discordRichPresence = true;
        }
        if (version < 7) s.adultProvidersUnavailable = true;
        if (version < 9) {
          s.subtitleEnabled = s.subtitleEnabled ?? true;
          s.subtitleFontSize = s.subtitleFontSize ?? 24;
          s.subtitleColor = s.subtitleColor ?? '#ffffff';
        }
        return s as SettingsState;
      },
    },
  ),
);