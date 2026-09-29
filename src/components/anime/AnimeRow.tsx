import { useRef } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { AnimeSummary } from '@/types';
import AnimeCard from './AnimeCard';
import Skeleton from '@/components/ui/Skeleton';

interface Props {
  title: string;
  items?: AnimeSummary[];
  loading?: boolean;
  /** #7: watched fraction (0..1) per item — renders a progress bar (Continue Watching). */
  getProgress?: (a: AnimeSummary) => number | undefined;
  /** Per-item link override (e.g. Continue Watching resumes the episode). */
  getHref?: (anime: AnimeSummary) => string | undefined;
  /** Per-item cover label (e.g. "E7"). */
  getBadge?: (anime: AnimeSummary) => string | undefined;
}

export default function AnimeRow({ title, items, loading, getProgress, getHref, getBadge }: Props) {
  const scroller = useRef<HTMLDivElement>(null);

  const scroll = (dir: 1 | -1) =>
    scroller.current?.scrollBy({
      left: dir * scroller.current.clientWidth * 0.8,
      behavior: 'smooth',
    });

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">{title}</h2>
        <div className="flex gap-1">
          <button
            onClick={() => scroll(-1)}
            aria-label="Scroll left"
            className="rounded-full p-1.5 text-zinc-400 transition hover:bg-ink-800 hover:text-white"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            onClick={() => scroll(1)}
            aria-label="Scroll right"
            className="rounded-full p-1.5 text-zinc-400 transition hover:bg-ink-800 hover:text-white"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      </div>
      <div ref={scroller} className="no-scrollbar flex gap-4 overflow-x-auto pb-1">
        {loading &&
          Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="aspect-[2/3] w-[150px] shrink-0 sm:w-[170px]" />
          ))}
        {!loading && items?.map((a, i) => {
          const p = getProgress?.(a);
          return (
            <div key={a.id} className="relative w-[150px] shrink-0 sm:w-[170px]">
              <AnimeCard anime={a} index={i} href={getHref?.(a)} badge={getBadge?.(a)} />
              {p != null && p > 0 && (
                <div className="pointer-events-none absolute bottom-1.5 left-2 right-2 h-1 overflow-hidden rounded-full bg-white/20">
                  <div
                    className="h-full rounded-full bg-accent-500"
                    style={{ width: `${Math.min(100, p * 100)}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
        {!loading && items && items.length === 0 && (
          <p className="py-8 text-sm text-zinc-500">Nothing here yet.</p>
        )}
      </div>
    </section>
  );
}
