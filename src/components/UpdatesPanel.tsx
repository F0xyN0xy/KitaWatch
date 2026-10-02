import { useState, useEffect, useRef } from 'react';
import { useAnimeStore } from '@/stores/animeStore';
import { Bell, ListPlus, ExternalLink, Tv } from 'lucide-react';
import { useAuthStore } from '@/stores/authStore';
import { importUserLists, entryToAnimeSummary, type AniListList } from '@/services/anilistSync';

/** localStorage key: timestamp of last successful import — prevents
 *  re-importing (and re-creating lists) on every cold start. */
const LAST_IMPORT_KEY = 'kitawatch-last-list-import';
/** Minimum interval between auto-imports (6 hours). */
const AUTO_IMPORT_INTERVAL = 6 * 60 * 60 * 1000;

export default function UpdatesPanel() {
  const { accessToken, viewer } = useAuthStore();
  const createList = useAnimeStore((s) => s.createList);
  const upsertToList = useAnimeStore((s) => s.upsertToList);
  const [lists, setLists] = useState<AniListList[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  /** Guards against the effect re-firing while an import is in flight. */
  const importingRef = useRef(false);

  const importLists = async (isAuto = false) => {
    if (!accessToken || !viewer || importingRef.current) return;
    importingRef.current = true;
    setLoading(true);
    setMessage('Importing lists...');
    try {
      const imported = await importUserLists(accessToken, viewer.name);
      setLists(imported);

      // upsertToList handles dedup AND upgrades placeholder entries that
      // previous imports left behind (same id → data replaced with real
      // title/cover). Import ALL statuses including COMPLETED.
      let added = 0;
      let skippedNoMedia = 0;
      for (const list of imported) {
        const listId = createList(list.name);
        for (const entry of list.entries) {
          // Skip entries where AniList returned no media data — these are
          // deleted/private entries that would show as broken placeholders.
          if (!entry.media) {
            skippedNoMedia++;
            continue;
          }
          const anime = entryToAnimeSummary(entry);
          upsertToList(listId, anime);
          added++;
        }
      }
      if (skippedNoMedia > 0) {
        console.warn(`[kitawatch] import: skipped ${skippedNoMedia} entries with no media data`);
      }

      localStorage.setItem(LAST_IMPORT_KEY, String(Date.now()));
      const total = imported.reduce((s, l) => s + l.entries.length, 0);
      setMessage(
        isAuto
          ? `Auto-imported ${total} entries (${added} new).`
          : `Imported ${total} entries (${added} new).`,
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setLoading(false);
      importingRef.current = false;
    }
  };

  // Auto-import on app open — but at most once every 6 hours, never twice
  // in the same session, and only when there is something new to pull.
  useEffect(() => {
    if (!accessToken || !viewer || lists.length > 0 || importingRef.current) return;
    const last = Number(localStorage.getItem(LAST_IMPORT_KEY) ?? 0);
    if (Date.now() - last < AUTO_IMPORT_INTERVAL) return;
    importLists(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, viewer]);

  return (
    <section className="rounded-2xl bg-ink-900 p-5 ring-1 ring-white/5 mt-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
        <Bell className="h-4 w-4" /> Updates &amp; Lists
      </h2>
      <p className="text-xs text-zinc-400 mb-3">
        Import your AniList lists (watching, planning, completed) — real titles and covers,
        synced into My Lists. Auto-imports at most once every 6 hours.
      </p>
      <button
        onClick={() => importLists(false)}
        disabled={loading || !accessToken}
        className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3 py-2 text-xs font-semibold text-white hover:bg-accent-500 disabled:opacity-50"
      >
        <ListPlus className="h-3.5 w-3.5" /> {loading ? 'Importing...' : 'Import My Lists'}
      </button>
      {message && <p className="text-xs text-accent-300 mt-2">{message}</p>}
      {!accessToken && (
        <p className="text-xs text-zinc-600 mt-2">Log in with AniList above to use list import.</p>
      )}
      {lists.length > 0 && (
        <div className="mt-3 space-y-2">
          {lists.map((list) => (
            <div key={list.name} className="rounded-lg bg-ink-800/40 p-2">
              <strong className="text-xs text-white capitalize">{list.name}</strong>
              <div className="mt-1 space-y-0.5">
                {list.entries.map((entry) => {
                  const anime = entryToAnimeSummary(entry);
                  return (
                    <a
                      key={entry.mediaId}
                      href={`/anime/${entry.mediaId}`}
                      className="flex items-center gap-2 rounded px-1.5 py-1 text-[11px] text-zinc-300 hover:bg-ink-700/60 hover:text-white transition"
                      title={`${entry.status} — ep ${entry.progress}`}
                    >
                      {anime.cover ? (
                        <img
                          src={anime.cover}
                          alt=""
                          className="h-8 w-6 rounded object-cover shrink-0"
                          onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                        />
                      ) : (
                        <span className="flex h-8 w-6 shrink-0 items-center justify-center rounded bg-ink-700 text-[8px] text-zinc-600">
                          <Tv className="h-3 w-3" />
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate">{anime.title}</span>
                      <span className="shrink-0 text-[9px] text-zinc-500">
                        {entry.status} · ep {entry.progress}
                      </span>
                      <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-40" />
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
