import { useSettingsStore } from '@/stores/settingsStore';

/**
 * Discord Rich Presence bridge. All failures are swallowed: presence is a
 * bonus, never something that can break playback or navigation.
 */

const send = async (cmd: string, args: Record<string, unknown>) => {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke(cmd, args);
  } catch (e) {
    console.warn('[discord] invoke failed:', cmd, e);
  }
};

/** Show "Watching X — Episode N" in Discord. No-op unless enabled + configured. */
export function setDiscordPresence(details: string, state?: string): void {
  const { discordRichPresence, discordAppId } = useSettingsStore.getState();
  if (!discordRichPresence || !discordAppId) return;
  void send('discord_presence_set', {
    appId: discordAppId,
    details,
    state: state ?? null,
    start: Math.floor(Date.now() / 1000),
  });
}

/** Remove the presence (navigating away from the watch page). */
export function clearDiscordPresence(): void {
  if (!useSettingsStore.getState().discordRichPresence) return;
  void send('discord_presence_clear', {});
}
