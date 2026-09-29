import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Bookmark, Check, ListPlus, Pencil, Plus, Trash2, X } from 'lucide-react';
import PageContainer from '@/components/layout/PageContainer';
import AnimeCard from '@/components/anime/AnimeCard';
import Button from '@/components/ui/Button';
import { useAnimeStore } from '@/stores/animeStore';
import type { AnimeSummary } from '@/types';

const FAVORITES_ID = '__favorites__';

function ManageableCard({
  anime,
  index,
  onRemove,
}: {
  anime: AnimeSummary;
  index: number;
  onRemove: () => void;
}) {
  return (
    <div className="group relative">
      <AnimeCard anime={anime} index={index} />
      <button
        onClick={onRemove}
        title="Remove from this list"
        className="absolute right-2 top-2 z-10 hidden rounded-full bg-black/70 p-1.5 text-zinc-300 ring-1 ring-white/20 transition hover:bg-red-600/80 hover:text-white group-hover:block"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export default function MyList() {
  const favorites = useAnimeStore((s) => s.favorites);
  const customLists = useAnimeStore((s) => s.customLists);
  const createList = useAnimeStore((s) => s.createList);
  const renameList = useAnimeStore((s) => s.renameList);
  const deleteList = useAnimeStore((s) => s.deleteList);
  const removeFavorite = useAnimeStore((s) => s.removeFavorite);
  const removeFromList = useAnimeStore((s) => s.removeFromList);

  const [activeId, setActiveId] = useState<string>(FAVORITES_ID);
  const [naming, setNaming] = useState<string | null>(null); // list id being renamed / new
  const [nameDraft, setNameDraft] = useState('');

  const activeList = customLists.find((l) => l.id === activeId);
  // The active list may have been deleted — fall back to favorites.
  const effectiveId = activeId !== FAVORITES_ID && !activeList ? FAVORITES_ID : activeId;

  const items: AnimeSummary[] = effectiveId === FAVORITES_ID ? favorites : (activeList?.anime ?? []);

  const submitName = () => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setNaming(null);
      return;
    }
    if (naming === 'new') {
      setActiveId(createList(trimmed));
    } else if (naming) {
      renameList(naming, trimmed);
    }
    setNaming(null);
    setNameDraft('');
  };

  const listPill = (id: string, label: string, count: number) => (
    <button
      key={id}
      onClick={() => setActiveId(id)}
      className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm ring-1 transition ${
        effectiveId === id
          ? 'bg-accent-600/20 font-medium text-accent-300 ring-accent-500/50'
          : 'bg-ink-850 text-zinc-400 ring-white/10 hover:text-zinc-100'
      }`}
    >
      {label}
      <span className="text-xs text-zinc-500">{count}</span>
    </button>
  );

  return (
    <PageContainer>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-2xl font-bold text-white">My List</h1>
        {listPill(FAVORITES_ID, 'Favorites', favorites.length)}
        {customLists.map((l) => listPill(l.id, l.name, l.anime.length))}
        {naming === 'new' ? (
          <span className="flex items-center gap-1.5">
            <input
              autoFocus
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitName();
                if (e.key === 'Escape') setNaming(null);
              }}
              placeholder="List name…"
              className="w-36 rounded-full bg-ink-800 px-3 py-1.5 text-sm text-zinc-200 ring-1 ring-accent-500/60 focus:outline-none"
            />
            <button onClick={submitName} className="text-emerald-400 hover:text-emerald-300" title="Create">
              <Check className="h-4 w-4" />
            </button>
          </span>
        ) : (
          <button
            onClick={() => {
              setNaming('new');
              setNameDraft('');
            }}
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm text-zinc-500 ring-1 ring-dashed ring-white/10 transition hover:text-accent-300 hover:ring-accent-500/40"
          >
            <Plus className="h-3.5 w-3.5" /> New list
          </button>
        )}
      </div>

      {effectiveId !== FAVORITES_ID && activeList && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <button
            onClick={() => {
              setNaming(activeList.id);
              setNameDraft(activeList.name);
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 ring-1 ring-white/10 transition hover:text-zinc-200"
          >
            <Pencil className="h-3 w-3" /> Rename
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Delete "${activeList.name}"? The anime stay in other lists.`)) {
                deleteList(activeList.id);
                setActiveId(FAVORITES_ID);
              }
            }}
            className="flex items-center gap-1 rounded-lg px-2 py-1 ring-1 ring-white/10 transition hover:text-red-400"
          >
            <Trash2 className="h-3 w-3" /> Delete list
          </button>
        </div>
      )}

      {naming && naming !== 'new' && (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitName();
              if (e.key === 'Escape') setNaming(null);
            }}
            className="w-64 rounded-lg bg-ink-800 px-3 py-2 text-sm text-zinc-200 ring-1 ring-accent-500/60 focus:outline-none"
          />
          <Button variant="outline" size="sm" onClick={submitName}>
            <Check className="h-3.5 w-3.5" /> Save name
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl bg-ink-900 py-20 ring-1 ring-white/5">
          {effectiveId === FAVORITES_ID ? (
            <Bookmark className="h-12 w-12 text-zinc-700" />
          ) : (
            <ListPlus className="h-12 w-12 text-zinc-700" />
          )}
          <div className="text-center">
            <p className="font-semibold text-zinc-300">
              {effectiveId === FAVORITES_ID ? 'Your list is empty' : 'This list is empty'}
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              Save anime with &ldquo;Add to List&rdquo; to find them here.
            </p>
          </div>
          <Link to="/browse">
            <Button variant="outline">Browse anime</Button>
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
          {items.map((a, i) => (
            <ManageableCard
              key={a.id}
              anime={a}
              index={i}
              onRemove={() =>
                effectiveId === FAVORITES_ID
                  ? removeFavorite(a.id)
                  : removeFromList(effectiveId, a.id)
              }
            />
          ))}
        </div>
      )}
    </PageContainer>
  );
}
