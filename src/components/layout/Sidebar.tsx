import { Link, NavLink, useLocation } from 'react-router-dom';
import { motion, type Variants } from 'framer-motion';
import {
  Play,
  Home,
  TrendingUp,
  Flame,
  Bookmark,
  Settings,
} from 'lucide-react';
import Disclaimer from '@/components/ui/Disclaimer';

const navItems = [
  {
    to: '/',
    label: 'Home',
    icon: Home,
    match: (p: string) =>
      p === '/' ||
      (!p.startsWith('/browse') &&
        !p.startsWith('/anime') &&
        !p.startsWith('/watch') &&
        !['/my-list', '/settings'].includes(p)),
  },
  {
    to: '/browse?sort=trending',
    label: 'Trending',
    icon: TrendingUp,
    match: (p: string, s: string) => {
      if (p !== '/browse') return false;
      const sp = new URLSearchParams(s);
      return !sp.get('q') && !sp.get('genre') && sp.get('sort') !== 'popular' && sp.get('sort') !== 'recent';
    },
  },
  {
    to: '/browse?sort=popular',
    label: 'Popular',
    icon: Flame,
    match: (p: string, s: string) =>
      p === '/browse' && new URLSearchParams(s).get('sort') === 'popular' && !new URLSearchParams(s).get('q'),
  },
  {
    to: '/my-list',
    label: 'My List',
    icon: Bookmark,
    match: (p: string) => p === '/my-list',
  },
  {
    to: '/settings',
    label: 'Settings',
    icon: Settings,
    match: (p: string) => p === '/settings',
  },
];

const listVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const itemVariants: Variants = {
  hidden: { opacity: 0, x: -12 },
  show: { opacity: 1, x: 0, transition: { duration: 0.3, ease: 'easeOut' } },
};

export default function Sidebar() {
  const { pathname, search } = useLocation();

  return (
    <motion.aside
      initial={{ opacity: 0, x: -24 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.35, ease: 'easeOut' }}
      className="hidden w-60 shrink-0 flex-col border-r border-white/5 bg-ink-900/60 md:flex"
    >
      <div className="flex h-16 items-center gap-2.5 border-b border-white/5 px-5">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 shadow-lg shadow-accent-600/30">
          <Play className="h-4 w-4 fill-white text-white" />
        </div>
        <span className="text-lg font-bold tracking-tight text-white">
          Kita<span className="text-accent-400">Watch</span>
        </span>
      </div>

      <motion.nav
        variants={listVariants}
        initial="hidden"
        animate="show"
        className="flex flex-col gap-1 p-3"
      >
        {navItems.map(({ to, label, icon: Icon, match }) => {
          const active = match(pathname, search);
          return (
            <motion.div key={label} variants={itemVariants}>
              <NavLink
                to={to}
                className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  active
                    ? 'bg-accent-600/15 text-accent-300 ring-1 ring-accent-500/30'
                    : 'text-zinc-400 hover:bg-ink-800 hover:text-zinc-100'
                }`}
              >
                <Icon className="h-4.5 w-4.5" />
                {label}
              </NavLink>
            </motion.div>
          );
        })}
      </motion.nav>

      <div className="mt-auto space-y-2 p-4">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
          <Link to="/terms" className="text-zinc-500 hover:text-zinc-300">Terms</Link>
          <Link to="/privacy" className="text-zinc-500 hover:text-zinc-300">Privacy</Link>
          <Link to="/dmca" className="text-zinc-500 hover:text-zinc-300">DMCA</Link>
          <a
            href="https://github.com/F0xyN0xy/KitaWatch/issues"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-500 hover:text-zinc-300"
          >
            Bugs & Ideas
          </a>
          <a
            href="https://kitawatch.free.nf"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-500 hover:text-zinc-300"
          >
            kitawatch.free.nf
          </a>
        </div>
        <Disclaimer />
        <p className="text-[10px] uppercase tracking-widest text-zinc-700">
          v0.7.1
        </p>
      </div>
    </motion.aside>
  );
}