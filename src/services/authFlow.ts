import { useAuthStore } from '@/stores/authStore';
import { useAnimeStore } from '@/stores/animeStore';
import { anilist, exchangeAuthCode } from '@/services/anilist';

// Settings registers a notifier so login progress/errors are visible
let notifier: ((msg: string) => void) | null = null;
export function setAuthNotifier(fn: (msg: string) => void) {
  notifier = fn;
}
function notify(msg: string) {
  notifier?.(msg);
}

// Set true when the user clicks Connect; App polls getCurrent() while true
let pending = false;
export function markLoginPending(v: boolean) {
  pending = v;
}
export function isLoginPending() {
  return pending;
}

async function finishWithToken(token: string): Promise<boolean> {
  notify('Fetching your AniList profile…');
  const { Viewer } = await anilist.viewer(token);
  useAuthStore.getState().setSession(token, {
    id: Viewer.id,
    name: Viewer.name,
    avatar: Viewer.avatar?.large ?? undefined,
  });
  notify(`Logged in as ${Viewer.name} — syncing favorites…`);
  const remote = await anilist.importFavorites(token, Viewer.name);
  useAnimeStore.getState().mergeFavorites(remote);
  notify(`Welcome, ${Viewer.name}!`);
  return true;
}

/** Complete the OAuth handshake.
 *  Accepts either:
 *  - a kitawatch://auth?code=... deep-link callback URL, or
 *  - a raw access token (AniList's "auth pin" flow: redirect URL
 *    https://anilist.co/api/v2/oauth/pin shows the token on a page).
 *  The code exchange runs in Rust and reads client credentials from .env. */
export async function completeLogin(raw: string): Promise<boolean> {
  const input = raw.trim();
  if (!input) {
    notify('Nothing to submit');
    return false;
  }

  // Case 1: raw access token (paste from the anilist.co pin page)
  if (!input.includes('://') && !input.includes('=')) {
    const token = input.replace(/["'\s]/g, '');
    if (!/^[A-Za-z0-9]{100,}$/.test(token)) {
      notify('That does not look like an AniList token — copy the long hex string from the pin page');
      markLoginPending(false);
      return false;
    }
    try {
      return await finishWithToken(token);
    } catch (e) {
      notify(e instanceof Error ? `That token didn't work: ${e.message}` : 'Token rejected');
      return false;
    } finally {
      markLoginPending(false);
    }
  }

  // Case 1b: pasted URL containing access_token= (some pin flows put it in the URL)
  if (input.includes('access_token=')) {
    try {
      const u = new URL(input.includes('://') ? input : `https://${input}`);
      const t = u.searchParams.get('access_token');
      if (t) {
        try {
          return await finishWithToken(t);
        } catch (e) {
          notify(e instanceof Error ? `That token didn't work: ${e.message}` : 'Token rejected');
          return false;
        } finally {
          markLoginPending(false);
        }
      }
    } catch {
      // fall through to normal URL handling
    }
  }

  // Case 2: kitawatch://auth?code=... callback URL
  // Whitelist: only allow http(s) URLs and the app's deep-link scheme
  const allowedProtocols = ['http:', 'https:', 'kitawatch:'];
  const allowedHosts = ['auth', 'anilist.co', 'graphql.anilist.co', 'www.anilist.co'];
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    notify('Could not parse that as a URL or token');
    return false;
  }
  // Validate protocol and host against whitelist
  if (!allowedProtocols.includes(url.protocol)) {
    notify('Invalid URL protocol');
    return false;
  }
  if (!allowedHosts.includes(url.hostname)) {
    notify('That is not a KitaWatch auth callback URL');
    return false;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    notify('No authorization code found in the URL');
    return false;
  }

  notify('Exchanging code with AniList (via local backend)…');
  try {
    const token = await exchangeAuthCode(code);
    return await finishWithToken(token);
  } catch (e) {
    notify(e instanceof Error ? e.message : 'Login failed');
    return false;
  } finally {
    markLoginPending(false);
  }
}
