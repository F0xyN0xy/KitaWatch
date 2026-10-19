export interface DiscordAuthCallback {
  code: string;
}

/** Only accept the app's explicit Discord OAuth callback, never arbitrary URLs. */
export function parseDiscordAuthCallback(rawUrl: string): DiscordAuthCallback | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'kitawatch:' || url.hostname !== 'auth') return null;
    if (url.searchParams.get('provider') !== 'discord') return null;
    const code = url.searchParams.get('code');
    if (!code) return null;
    return { code };
  } catch {
    return null;
  }
}
