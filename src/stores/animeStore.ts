import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AnimeSummary } from '@/types';

export interface CustomList {
  id: string;
  name: string;
  anime: AnimeSummary[];
  createdAt: number;
}

interface AnimeState {
  favorites: AnimeSummary[];
  toggleFavorite: (anime: AnimeSummary) => void;
  removeFavorite: (id: number) => void;
  isFavorite: (id: number) => boolean;
  /** Merge remote (AniList) favorites without duplicating local ones. */
  mergeFavorites: (list: AnimeSummary[]) => void;

  /** User-created named lists, in creation order. */
  customLists: CustomList[];
  /** Create a list; returns its id. No-op (returns existing id) on duplicates. */
  createList: (name: string) => string;
  renameList: (id: string, name: string) => void;
  deleteList: (id: string) => void;
  addToList: (listId: string, anime: AnimeSummary) => void;
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
      renameList: (id, name) =>
        set((s) => ({
          customLists: s.customLists.map((l) =>
            l.id === id ? { ...l, name: name.trim() || l.name } : l,
          ),
        })),
      deleteList: (id) =>
        set((s) => ({ customLists: s.customLists.filter((l) => l.id !== id) })),
      addToList: (listId, anime) =>
        set((s) => ({
          customLists: s.customLists.map((l) =>
            l.id === listId && !l.anime.some((a) => a.id === anime.id)
              ? { ...l, anime: [anime, ...l.anime] }
              : l,
          ),
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
