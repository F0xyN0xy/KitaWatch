import { memo } from 'react';
import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Star } from 'lucide-react';
import type { AnimeSummary } from '@/types';
import Badge from '@/components/ui/Badge';

interface Props {
  anime: AnimeSummary;
  index?: number;
  /** Override the default /anime/:id destination (e.g. resume playback). */
  href?: string;
  /** Small accent label shown on the cover (e.g. "E7"). */
  badge?: string;
}

function AnimeCard({ anime, index = 0, href, badge }: Props) {
  const rating = typeof anime.rating === 'number' ? anime.rating : undefined;

  // normalizeAnime falls back to id 0 when upstream IDs won't parse —
  // a card without a real ID can't navigate anywhere useful.
  if (!anime.id) {
    return (
      <div className="rounded-xl bg-ink-800 p-3 text-xs text-zinc-600 ring-1 ring-white/5">
        {anime.title} (missing ID)
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: Math.min(index * 0.04, 0.4), ease: 'easeOut' }}
    >
      <Link to={href ?? `/anime/${anime.id}`} className="group block">
        <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-ink-800 ring-1 ring-white/5 transition duration-300 group-hover:shadow-[0_0_28px_rgba(168,85,247,0.25)] group-hover:ring-accent-500/60">
          {anime.cover || anime.banner ? (
            <img
              src={anime.cover ?? anime.banner}
              alt={anime.title}
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-zinc-600">
              No cover
            </div>
          )}
          {rating != null && (
            <div className="absolute right-2 top-2">
              <Badge variant="rating">
                <Star className="h-3 w-3 fill-current" />
                {rating.toFixed(1)}
              </Badge>
            </div>
          )}
          {badge && (
            <div className="absolute left-2 top-2">
              <Badge variant="accent">{badge}</Badge>
            </div>
          )}
          <div className="absolute bottom-2 left-2 flex gap-1">
            {(anime.subCount ?? 0) > 0 && <Badge variant="sub">Sub</Badge>}
            {(anime.dubCount ?? 0) > 0 && <Badge variant="dub">Dub</Badge>}
          </div>
        </div>
        <p className="mt-2 line-clamp-2 text-sm font-medium text-zinc-300 transition group-hover:text-white">
          {anime.title}
        </p>
      </Link>
    </motion.div>
  );
}

export default memo(AnimeCard);
