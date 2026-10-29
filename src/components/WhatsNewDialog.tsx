import { useEffect, useMemo, useState } from 'react';
import { Check, Clipboard, ExternalLink, LoaderCircle, Newspaper, X } from 'lucide-react';
import ReleaseMarkdown from '@/components/ReleaseMarkdown';

type Release = {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
};

type Props = { open: boolean; appVersion: string; onClose: () => void };

export default function WhatsNewDialog({ open, appVersion, onClose }: Props) {
  const [releases, setReleases] = useState<Release[]>([]);
  const [selectedTag, setSelectedTag] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setCopied(false);
    fetch('https://api.github.com/repos/F0xyN0xy/KitaWatch/releases?per_page=10', {
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
        return (await response.json()) as Release[];
      })
      .then((items) => {
        const published = items.filter((release) => !release.draft);
        setReleases(published);
        const installedTag = `v${appVersion}`;
        setSelectedTag(
          published.some((release) => release.tag_name === installedTag)
            ? installedTag
            : (published[0]?.tag_name ?? ''),
        );
      })
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return;
        setError('Release notes could not be loaded. Check your connection and try again.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, appVersion]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const selected = useMemo(
    () => releases.find((release) => release.tag_name === selectedTag),
    [releases, selectedTag],
  );
  const hasInstalledRelease = releases.some((release) => release.tag_name === `v${appVersion}`);

  if (!open) return null;

  const copyNotes = async () => {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(
        selected.body?.trim() || `KitaWatch ${selected.tag_name}`,
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError('Could not copy to the clipboard. Check clipboard permissions.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="flex max-h-[min(680px,90vh)] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-950 shadow-2xl shadow-black/40"
      >
        <header className="flex items-start justify-between gap-4 border-b border-white/10 bg-ink-900/80 px-5 py-4 sm:px-6">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-500/15 text-accent-300 ring-1 ring-accent-400/20">
              <Newspaper className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-300">Release notes</p>
              <h2 id="whats-new-title" className="mt-1 text-xl font-semibold tracking-tight text-white">What’s new in KitaWatch?</h2>
              <p className="mt-1 text-sm text-zinc-500">Installed version: v{appVersion}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close What's New" className="rounded-lg p-2 text-zinc-500 transition hover:bg-white/10 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 md:grid-cols-[210px_minmax(0,1fr)]">
          <aside className="max-h-40 overflow-y-auto border-b border-white/10 p-3 md:max-h-none md:border-b-0 md:border-r">
            <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">Recent releases</p>
            {loading && releases.length === 0 ? (
              <div className="flex items-center gap-2 px-2 py-3 text-xs text-zinc-500"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading releases…</div>
            ) : releases.length === 0 ? (
              <p className="px-2 py-3 text-xs leading-5 text-zinc-500">{error || 'No published releases were found.'}</p>
            ) : (
              <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible" aria-label="Release history">
                {releases.map((release) => (
                  <button key={release.tag_name} type="button" onClick={() => { setSelectedTag(release.tag_name); setCopied(false); }} aria-current={selectedTag === release.tag_name ? 'true' : undefined}
                    className={`min-w-max rounded-lg px-3 py-2 text-left text-sm transition md:w-full md:min-w-0 ${selectedTag === release.tag_name ? 'bg-accent-500/15 text-accent-200 ring-1 ring-accent-500/30' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100'}`}>
                    <span className="block font-medium">{release.name || release.tag_name}</span>
                    <span className="mt-0.5 block text-[11px] opacity-65">{release.tag_name}</span>
                  </button>
                ))}
              </nav>
            )}
          </aside>

          <main className="min-h-0 overflow-y-auto px-5 py-5 sm:px-6">
            {loading && releases.length === 0 ? (
              <div className="flex items-center gap-2 text-sm text-zinc-400"><LoaderCircle className="h-4 w-4 animate-spin" /> Fetching notes from GitHub…</div>
            ) : selected ? (
              <>
                {selected.tag_name !== `v${appVersion}` && !hasInstalledRelease && (
                  <p className="mb-4 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-xs leading-5 text-amber-200/80">
                    Notes for v{appVersion} aren’t published yet, so this is the latest available release.
                  </p>
                )}
                <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-white">{selected.name || selected.tag_name}</h3>
                    {selected.published_at && <p className="mt-1 text-xs text-zinc-500">Published {new Date(selected.published_at).toLocaleDateString()}</p>}
                  </div>
                  <a href={selected.html_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-white/5 hover:text-white">
                    View on GitHub <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
                <ReleaseMarkdown source={selected.body?.trim() || 'No release notes were added for this version.'} />
              </>
            ) : (
              <div className="flex h-full min-h-32 flex-col items-start justify-center gap-3">
                <p className="text-sm leading-6 text-zinc-400">{error || 'Release notes are unavailable right now. KitaWatch will continue to work normally.'}</p>
                <a href="https://github.com/F0xyN0xy/KitaWatch/releases" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-sm font-medium text-accent-300 hover:text-accent-200">
                  Browse releases on GitHub <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            )}
          </main>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-ink-900/50 px-5 py-4 sm:px-6">
          <p className="text-xs text-zinc-600">Release information is fetched from GitHub.</p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={copyNotes} disabled={!selected} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs font-medium text-zinc-300 transition hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40">
              {copied ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}{copied ? 'Copied!' : 'Copy release notes'}
            </button>
            <button type="button" onClick={onClose} className="rounded-lg bg-accent-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-accent-500">Got it</button>
          </div>
        </footer>
      </section>
    </div>
  );
}
