import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const MAX_ENTRIES = 50;

export interface HistoryEntry {
  animeId: number;
  episode: number;
  title: string;
  cover?: string;
  /** Last playback position / total duration in seconds (resume support). */
  position?: number;
  duration?: number;
  updatedAt: number;
}

/**
 * Franchise key: a normalized title with season/part markers stripped.
 * "Attack on Titan Season 2" and "Attack on Titan: Final Season" both
 * reduce to "attack on titan". Used to stop seasons of the same show from
 * piling up as separate Continue Watching cards.
 */
export function franchiseKey(title: string): string {
  return title
    .toLowerCase()
    // strip common season markers before punctuation removal
    .replace(/\b(season|part|cour)\s+[0-9]+\b/g, ' ')
    .replace(/\b[0-9]+(?:st|nd|rd|th)\s+season\b/g, ' ')
    .replace(/\b(?:2nd|3rd|[4-9]th)\s+season\b/g, ' ')
    .replace(/\bseason\s+(?:2nd|3rd|[4-9]th)\b/g, ' ')
    // roman-numeral season suffixes ("... II", "... III", "... IV")
    .replace(/\s+(?:i{2,3}v?|iv|v|vi|vii|viii|ix|x)\s*$/i, ' ')
    .replace(/[''`’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

interface HistoryState {
  entries: HistoryEntry[];
  upsert: (e: Omit<HistoryEntry, 'position' | 'duration' | 'updatedAt'>) => void;
  updatePosition: (animeId: number, episode: number, position: number, duration: number) => void;
  remove: (animeId: number) => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      entries: [],
      upsert: (e) =>
        set((s) => {
          const prev = s.entries.find((x) => x.animeId === e.animeId);
          // Resume semantics: never roll back to an earlier episode when the
          // same anime is opened again (e.g. "Play" from the detail page).
          const episode = prev ? Math.max(prev.episode, e.episode) : e.episode;
          // Resume data is per-episode — only carry it over when this upsert
          // is for the same episode the user actually watched. Episode 1's
          // progress must not leak into the entry after they jump to ep 5.
          const keep =
            prev && prev.episode === e.episode
              ? { position: prev.position, duration: prev.duration }
              : {};
          const entry: HistoryEntry = { ...e, episode, ...keep, updatedAt: Date.now() };
          return {
            entries: [
              entry,
              // same anime OR another season of the same franchise: keep one
              ...s.entries.filter(
                (x) => x.animeId !== e.animeId && franchiseKey(x.title) !== franchiseKey(e.title),
              ),
            ].slice(0, MAX_ENTRIES),
          };
        }),
      updatePosition: (animeId, episode, position, duration) =>
        set((s) => ({
          entries: s.entries.map((x) =>
            x.animeId === animeId && x.episode === episode
              ? { ...x, position, duration, updatedAt: Date.now() }
              : x,
          ),
        })),
      remove: (animeId) => set((s) => ({ entries: s.entries.filter((e) => e.animeId !== animeId) })),
    }),
    { name: 'kitawatch-history' },
  ),
);
