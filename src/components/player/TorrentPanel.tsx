import { useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2, Magnet, Search } from 'lucide-react';
import Button from '@/components/ui/Button';
import { searchNyaa, nyaaSearchUrl, type NyaaResult } from '@/services/nyaa';
import { startTorrentStream } from '@/services/torrent';

interface Props {
  animeTitle: string;
  onStream: (url: string, label: string) => void;
}

export default function TorrentPanel({ animeTitle, onStream }: Props) {
  const [query, setQuery] = useState(animeTitle);
  const [results, setResults] = useState<NyaaResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMagnet, setLoadingMagnet] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');

  const search = async () => {
    setSearching(true);
    setError('');
    setResults(null);
    try {
      setResults(await searchNyaa(query));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setSearching(false);
    }
  };

  const pick = async (r: NyaaResult) => {
    setLoadingMagnet(r.magnet);
    setProgress(0);
    setError('');
    try {
      const { url, fileName } = await startTorrentStream(r.magnet, setProgress);
      onStream(url, `torrent · ${fileName}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Torrent failed');
    } finally {
      setLoadingMagnet(null);
    }
  };

  return (
    <div className="space-y-3 rounded-2xl bg-ink-900 p-4 ring-1 ring-white/5">
      <div className="flex items-center gap-2">
        <Magnet className="h-4 w-4 text-accent-400" />
        <h2 className="text-sm font-semibold text-white">
          Torrent fallback{' '}
          <span className="text-[10px] font-normal uppercase tracking-widest text-zinc-500">
            experimental
          </span>
        </h2>
      </div>
      <p className="text-xs text-zinc-500">
        Streams magnets peer-to-peer via WebTorrent. MP4 releases play best; MKV
        may not. You upload data while watching.
      </p>

      <div className="flex gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          className="flex-1 rounded-lg bg-ink-800 px-3 py-2 text-sm text-zinc-200 ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-accent-500/60"
        />
        <Button variant="outline" size="sm" onClick={search} disabled={searching || !query.trim()}>
          {searching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
          Search Nyaa
        </Button>
        <a
          href={nyaaSearchUrl(query || animeTitle)}
          target="_blank"
          rel="noreferrer"
          title="Open this search on nyaa.si in your browser"
          className="flex items-center rounded-lg bg-ink-800 px-3 py-2 text-xs text-zinc-300 ring-1 ring-white/10 transition hover:text-white hover:ring-accent-500/50"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-rose-400">
          <AlertTriangle className="h-3.5 w-3.5" /> {error}
        </p>
      )}

      {loadingMagnet && (
        <div className="space-y-1">
          <p className="text-xs text-zinc-400">Buffering torrent… {progress}%</p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-800">
            <div
              className="h-full bg-accent-500 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      {results && results.length === 0 && (
        <p className="text-xs text-zinc-500">No releases found — try a shorter title.</p>
      )}

      {results && results.length > 0 && (
        <ul className="max-h-64 space-y-1 overflow-y-auto pr-1">
          {results.map((r) => (
            <li key={r.magnet}>
              <button
                onClick={() => pick(r)}
                disabled={loadingMagnet !== null}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ring-1 ring-transparent transition hover:bg-ink-800 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                  {r.title}
                </span>
                <span className="shrink-0 text-[11px] text-zinc-500">{r.size}</span>
                <span className="shrink-0 text-[11px] text-emerald-400">
                  ▲ {r.seeders}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
