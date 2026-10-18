import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AnimeSummary } from '@/types';

export interface CustomList {
  id: string;
  name: string;
  anime: AnimeSummary[];
  createdAt: number;
}

/** Stable id for the automatically maintained, device-local playback list. */
export const KITAWATCH_LIST_ID = '__kitawatch_history__';

interface AnimeState {
  favorites: AnimeSummary[];
  toggleFavorite: (anime: AnimeSummary) => void;
  removeFavorite: (id: number) => void;
  isFavorite: (id: number) => boolean;
  /** Merge remote (AniList) favorites without duplicating local ones. */
  mergeFavorites: (list: AnimeSummary[]) => void;

  /** User-created named lists, plus the reserved KitaWatch playback list. */
  customLists: CustomList[];
  /** Create a list; returns its id. No-op (returns existing id) on duplicates. */
  createList: (name: string) => string;
  /** Add/update an anime in the reserved local playback list. */
  trackInKitaWatch: (anime: AnimeSummary) => void;
  renameList: (id: string, name: string) => void;
  deleteList: (id: string) => void;
  addToList: (listId: string, anime: AnimeSummary) => void;
  /** Add or UPDATE an entry: if the anime id already exists in the list its
   *  data is replaced (upgrades placeholder entries to real metadata). */
  upsertToList: (listId: string, anime: AnimeSummary) => void;
  removeFromList: (listId: string, animeId: number) => void;
  isInList: (listId: string, animeId: number) => boolean;
}

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const useAnimeStore = create<AnimeState>()(
  persist(
    (set, get) => ({
      favorites: [],
      toggleFavorite: (anime) =>
        set((s) =>
          s.favorites.some((f) => f.id === anime.id)
            ? { favorites: s.favorites.filter((f) => f.id !== anime.id) }
            : { favorites: [anime, ...s.favorites] },
        ),
      removeFavorite: (id) =>
        set((s) => ({ favorites: s.favorites.filter((f) => f.id !== id) })),
      isFavorite: (id) => get().favorites.some((f) => f.id === id),
      mergeFavorites: (list) =>
        set((s) => {
          const existing = new Set(s.favorites.map((f) => f.id));
          return { favorites: [...s.favorites, ...list.filter((a) => !existing.has(a.id))] };
        }),

      customLists: [],
      createList: (name) => {
        const trimmed = name.trim();
        const existing = get().customLists.find(
          (l) => l.name.toLowerCase() === trimmed.toLowerCase(),
        );
        if (existing) return existing.id;
        const id = newId();
        set((s) => ({
          customLists: [
            ...s.customLists,
            { id, name: trimmed || 'New list', anime: [], createdAt: Date.now() },
          ],
        }));
        return id;
      },
      trackInKitaWatch: (anime) =>
        set((s) => {
          // Adopt an existing user-created "KitaWatch" list so enabling this
          // feature never discards its entries when upgrading.
          const existing =
            s.customLists.find((l) => l.id === KITAWATCH_LIST_ID) ??
            s.customLists.find((l) => l.name.trim().toLowerCase() === 'kitawatch');
          const current = existing?.anime ?? [];
          const index = current.findIndex((entry) => entry.id === anime.id);
          const updatedAnime =
            index < 0
              ? [anime, ...current]
              : current.map((entry) => (entry.id === anime.id ? anime : entry));
          const tracked: CustomList = {
            id: KITAWATCH_LIST_ID,
            name: 'KitaWatch',
            anime: updatedAnime,
            createdAt: existing?.createdAt ?? Date.now(),
          };
          return {
            customLists: existing
              ? s.customLists.map((list) => (list === existing ? tracked : list))
              : [...s.customLists, tracked],
          };
        }),
      renameList: (id, name) => {
        if (id === KITAWATCH_LIST_ID) return;
        set((s) => ({
          customLists: s.customLists.map((l) =>
            l.id === id ? { ...l, name: name.trim() || l.name } : l,
          ),
        }));
      },
      deleteList: (id) => {
        if (id === KITAWATCH_LIST_ID) return;
        set((s) => ({ customLists: s.customLists.filter((l) => l.id !== id) }));
      },
      addToList: (listId, anime) =>
        set((s) => ({
          customLists: s.customLists.map((l) =>
            l.id === listId && !l.anime.some((a) => a.id === anime.id)
              ? { ...l, anime: [anime, ...l.anime] }
              : l,
          ),
        })),
      upsertToList: (listId, anime) =>
        set((s) => ({
          customLists: s.customLists.map((l) => {
            if (l.id !== listId) return l;
            const idx = l.anime.findIndex((a) => a.id === anime.id);
            if (idx === -1) {
              // Not present — prepend like addToList
              return { ...l, anime: [anime, ...l.anime] };
            }
            // Present — replace in-place so placeholder data gets upgraded
            // to real metadata (title, cover, etc.) on re-import.
            const next = [...l.anime];
            next[idx] = anime;
            return { ...l, anime: next };
          }),
        })),
      removeFromList: (listId, animeId) =>
        set((s) => ({
          customLists: s.customLists.map((l) =>
            l.id === listId ? { ...l, anime: l.anime.filter((a) => a.id !== animeId) } : l,
          ),
        })),
      isInList: (listId, animeId) =>
        get().customLists.some((l) => l.id === listId && l.anime.some((a) => a.id === animeId)),
    }),
    { name: 'kitawatch-favorites' },
  ),
);
