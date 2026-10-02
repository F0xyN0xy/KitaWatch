import { useState, useEffect } from 'react';
import { useAnimeStore } from '@/stores/animeStore';
import { Bell, ListPlus, ExternalLink, Tv } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { importUserLists } from '@/services/anilistSync';

export default function UpdatesPanel() {
  const { accessToken, viewer } = useAuthStore();
  const createList = useAnimeStore((s) => s.createList);
  const addToList = useAnimeStore((s) => s.addToList);
  const [lists, setLists] = useState<Array<{ name: string; entries: Array<{ mediaId: number; status: string; progress: number }> }>>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const importLists = async () => {
    if (!accessToken || !viewer) return;
    setLoading(true);
    setMessage('Importing lists...');
    try {
      const imported = await importUserLists(accessToken, viewer.name);
      setLists(imported);
      // Save to app store so it shows in "My Lists"
      for (const list of imported) {
        const listId = createList(list.name);
        for (const entry of list.entries.filter(e => e.status !== 'COMPLETED')) {
          addToList(listId, { id: entry.mediaId, title: `Anime #${entry.mediaId}`, cover: `https://picsum.photos/seed/anime${entry.mediaId}/100/150`, type: 'ANIME', rating: undefined, status: entry.status, releaseDate: undefined, season: undefined, year: undefined, totalEpisodes: undefined, synopsis: undefined, genres: undefined, banner: undefined } as import('@/types').AnimeSummary);
        }
      }
      setMessage(`Imported ${imported.reduce((s, l) => s + l.entries.length, 0)} entries.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  };

  // Auto-import on app open if logged in
  useEffect(() => {
    if (accessToken && viewer && lists.length === 0) {
      importLists();
    }
  }, [accessToken, viewer]);

  return (
    <section className="rounded-2xl bg-ink-900 p-5 ring-1 ring-white/5 mt-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
        <Bell className="h-4 w-4" /> Updates & Lists
      </h2>
      <p className="text-xs text-zinc-400 mb-3">Inside-app notifications + import your AniList lists (watching, planning, completed).</p>
      <button
        onClick={importLists}
        disabled={loading || !accessToken}
        className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3 py-2 text-xs font-semibold text-white hover:bg-accent-500 disabled:opacity-50"
      >
        <ListPlus className="h-3.5 w-3.5" /> Import My Lists
      </button>
      {message && <p className="text-xs text-accent-300 mt-2">{message}</p>}
      {lists.length > 0 && (
        <div className="mt-3 space-y-2">
          {lists.map((list) => (
            <div key={list.name} className="rounded-lg bg-ink-800/40 p-2">
              <strong className="text-xs text-white capitalize">{list.name}</strong>
              <div className="flex flex-wrap gap-1 mt-1">
                {list.entries.map((entry) => (
                  <a
                    key={entry.mediaId}
                    href={`/anime/${entry.mediaId}`}
                    className="inline-flex items-center gap-1 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] text-zinc-300 hover:text-white hover:ring-1 hover:ring-accent-500/40"
                    title={`${entry.status} — ep ${entry.progress}`}
                  >
                    <Tv className="h-2.5 w-2.5" /> #{entry.mediaId} <span className="text-[9px] text-zinc-500">({entry.status} · {entry.progress})</span>
                    <ExternalLink className="h-2 w-2 opacity-50" />
                  </a>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
