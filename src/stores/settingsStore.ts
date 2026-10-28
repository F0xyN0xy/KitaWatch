import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type Quality = 'auto' | '1080p' | '720p' | '480p';
export type ThemeAccent = 'violet' | 'blue' | 'emerald' | 'rose' | 'amber';
export type ThemeStyle = 'plum' | 'midnight' | 'graphite';

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
  // Additional Anivexa providers (lower priority unless moved by the user)
  'anidbapp',
  '2dhive',
  'animenosub',
  'senshi',
  'animedunya',
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
  themeAccent: ThemeAccent;
  themeStyle: ThemeStyle;
  defaultQuality: Quality;
  autoplayNext: boolean;
  /** Show subtitles by default in direct-media playback. */
  subtitleEnabled: boolean;
  /** Subtitle font size in pixels. */
  subtitleFontSize: number;
  /** Subtitle text color as a CSS hex color. */
  subtitleColor: string;
  /** Font family used by direct-stream subtitles. */
  subtitleFontFamily: string;
  /** Render subtitle text in bold. */
  subtitleBold: boolean;
  /** Add a strong dark outline for readability. */
  subtitleOutline: boolean;
  providerPriority: string[];
  /** Preferred source provider for each audio mode; empty means automatic. */
  preferredSubProvider: string;
  preferredDubProvider: string;
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
  /**
   * Push watch progress for adult (H) anime to AniList. Default off —
   * independent from showAdultContent so a user can browse H titles
   * without ever writing them to their public AniList history.
   */
  updateAdultProgress: boolean;
  /** Automatically add playable anime to the device-local KitaWatch list. */
  autoTrackKitaWatch: boolean;
  /** Temporarily hide adult content while its providers are unavailable. */
  adultProvidersUnavailable: boolean;
  /** Show the current anime/episode as Discord activity. */
  discordRichPresence: boolean;
  /**
   * Discord Application ID the rich presence connects with. Locked to
   * KitaWatch's own application — presence works out of the box for every
   * user (Settings only exposes an on/off toggle).
   */
  discordAppId: string;
  setThemeAccent: (accent: ThemeAccent) => void;
  setThemeStyle: (style: ThemeStyle) => void;
  setDefaultQuality: (q: Quality) => void;
  setAutoplayNext: (v: boolean) => void;
  setSubtitleEnabled: (v: boolean) => void;
  setSubtitleFontSize: (v: number) => void;
  setSubtitleColor: (v: string) => void;
  setSubtitleFontFamily: (v: string) => void;
  setSubtitleBold: (v: boolean) => void;
  setSubtitleOutline: (v: boolean) => void;
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
  setAutoTrackKitaWatch: (v: boolean) => void;
  setAdultProvidersUnavailable: (v: boolean) => void;
  setDiscordRichPresence: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      themeAccent: 'violet',
      themeStyle: 'plum',
      defaultQuality: 'auto',
      autoplayNext: true,
      subtitleEnabled: true,
      subtitleFontSize: 24,
      subtitleColor: '#ffffff',
      subtitleFontFamily: 'Arial, sans-serif',
      subtitleBold: false,
      subtitleOutline: true,
      providerPriority: [...PROVIDER_PRIORITY],
      preferredSubProvider: '',
      preferredDubProvider: '',
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
      // Never push adult-title progress to AniList unless the user
      // explicitly opts in — H entries would otherwise land in their
      // public activity feed the moment the toggle above is flipped.
      updateAdultProgress: false,
      // Keep the local playback list enabled by default; users can opt out.
      autoTrackKitaWatch: true,
      // Enabled by default while adult-content providers are under maintenance.
      adultProvidersUnavailable: true,
      // Rich presence is on by default and always uses KitaWatch's own
      // Discord application — users never need a Developer Portal app.
      discordRichPresence: true,
      discordAppId: '1553307716758536202',
      setThemeAccent: (themeAccent) => set({ themeAccent }),
      setThemeStyle: (themeStyle) => set({ themeStyle }),
      setDefaultQuality: (defaultQuality) => set({ defaultQuality }),
      setAutoplayNext: (autoplayNext) => set({ autoplayNext }),
      setSubtitleEnabled: (subtitleEnabled) => set({ subtitleEnabled }),
      setSubtitleFontSize: (subtitleFontSize) =>
        set({ subtitleFontSize: Math.min(40, Math.max(14, Math.round(subtitleFontSize))) }),
      setSubtitleColor: (subtitleColor) => set({ subtitleColor }),
      setSubtitleFontFamily: (subtitleFontFamily) => set({ subtitleFontFamily }),
      setSubtitleBold: (subtitleBold) => set({ subtitleBold }),
      setSubtitleOutline: (subtitleOutline) => set({ subtitleOutline }),
      setProviderPriority: (providerPriority) => set({ providerPriority }),
      setPreferredSubProvider: (preferredSubProvider) => set({ preferredSubProvider }),
      setPreferredDubProvider: (preferredDubProvider) => set({ preferredDubProvider }),
      setConsumetBaseUrl: (consumetBaseUrl) => set({ consumetBaseUrl }),
      setEnableConsumetFallback: (enableConsumetFallback) =>
        set({ enableConsumetFallback }),
      setProxyBaseUrl: (proxyBaseUrl) => set({ proxyBaseUrl }),
      setAnivexaBaseUrl: (anivexaBaseUrl) => set({ anivexaBaseUrl }),
      setEnableAnivexa: (enableAnivexa) => set({ enableAnivexa }),
      setRememberFullscreen: (rememberFullscreen) => set({ rememberFullscreen }),
      setLastFullscreen: (lastFullscreen) => set({ lastFullscreen }),
      setShowAdultContent: (showAdultContent) => set({ showAdultContent }),
      setUpdateAdultProgress: (updateAdultProgress) => set({ updateAdultProgress }),
      setAutoTrackKitaWatch: (autoTrackKitaWatch) => set({ autoTrackKitaWatch }),
      setAdultProvidersUnavailable: (adultProvidersUnavailable) =>
        set({ adultProvidersUnavailable }),
      setDiscordRichPresence: (discordRichPresence) => set({ discordRichPresence }),
    }),
    {
      name: 'kitawatch-settings',
      version: 13,
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
        if (version < 5) {
          // Rich presence became built-in: lock to the shared KitaWatch
          // Discord application ID so no user needs their own app.
          if (!s.discordAppId) s.discordAppId = '1553307716758536202';
          if (s.discordRichPresence == null) s.discordRichPresence = true;
        }
        // v6 introduced updateAdultProgress (AniList progress for H titles).
        // Absent in older persisted states — the false default above applies,
        // so upgrades keep the safe default. Nothing to rewrite.
        if (version < 7) {
          // Start the temporary provider-maintenance mode enabled on upgrade.
          s.adultProvidersUnavailable = true;
        }
        if (version < 9) {
          s.subtitleEnabled = s.subtitleEnabled ?? true;
          s.subtitleFontSize = s.subtitleFontSize ?? 24;
          s.subtitleColor = s.subtitleColor ?? '#ffffff';
        }
        if (version < 10) {
          s.subtitleFontFamily = s.subtitleFontFamily ?? 'Arial, sans-serif';
          s.subtitleBold = s.subtitleBold ?? false;
          s.subtitleOutline = s.subtitleOutline ?? true;
        }
        if (version < 11) {
          // Existing users get local playback tracking enabled unless they
          // explicitly opt out after this setting is introduced.
          s.autoTrackKitaWatch = s.autoTrackKitaWatch ?? true;
        }
        if (version < 12) {
          s.themeAccent = s.themeAccent ?? 'violet';
        }
        if (version < 13) {
          s.themeStyle = s.themeStyle ?? 'plum';
        }
        return s as SettingsState;
      },
    },
  ),
);