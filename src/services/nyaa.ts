import { useSettingsStore } from '@/stores/settingsStore';

export interface NyaaResult {
  title: string;
  magnet: string;
  size: string;
  seeders: number;
}

/**
 * Nyaa's RSS endpoint returns clean, stable XML — unlike the HTML search
 * page, which changes markup, sits behind Cloudflare, and broke the old
 * scraper constantly. Search via RSS, and build the magnet link ourselves
 * from the info hash instead of depending on whatever href the page happens
 * to carry ("create the link which Nyaa produces" — deterministic).
 */
const NYAA_RSS = 'https://nyaa.si/?page=rss&q={q}&c=1_2&f=0';

/** The tracker set Nyaa itself puts into its magnet links. */
const NYAA_TRACKERS = [
  'http://nyaa.tracker.wf:7777/announce',
  'udp://open.stealth.si:1337/announce',
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
];

function buildMagnet(infoHash: string, title: string): string {
  return (
    `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title)}` +
    NYAA_TRACKERS.map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  );
}

/** The plain Nyaa search URL for the same query — open-in-browser fallback. */
export function nyaaSearchUrl(query: string): string {
  return `https://nyaa.si/?q=${encodeURIComponent(query)}&c=1_2&f=0&s=seeders&o=desc`;
}

/** Search Nyaa (English-translated anime category) via RSS, sorted by seeders. */
export async function searchNyaa(query: string): Promise<NyaaResult[]> {
  const target = NYAA_RSS.replace('{q}', encodeURIComponent(query));

  const proxyBase = useSettingsStore.getState().proxyBaseUrl;
  const proxyUrl = `${proxyBase}/fetch?u=${encodeURIComponent(target)}&ref=${encodeURIComponent('https://nyaa.si/')}`;

  let xml: string;
  try {
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error('Proxy failed');
    xml = await res.text();
  } catch {
    throw new Error('Nyaa unreachable through local proxy');
  }

  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const items = [...doc.getElementsByTagName('item')];

  const results: NyaaResult[] = [];
  for (const it of items) {
    const text = (tag: string) =>
      it.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
    const title = text('title');
    const infoHash = text('nyaa:infoHash').toLowerCase();
    // Only accept entries we can build a real magnet for — a result without
    // a valid info hash is useless for streaming anyway.
    if (!title || !/^[a-f0-9]{40}$/.test(infoHash)) continue;
    results.push({
      title,
      magnet: buildMagnet(infoHash, title),
      size: text('nyaa:size'),
      seeders: Number(text('nyaa:seeders')) || 0,
    });
  }

  if (results.length === 0) {
    throw new Error(
      'No releases found — try a shorter title, or open the search directly on Nyaa.',
    );
  }

  return results.sort((a, b) => b.seeders - a.seeders).slice(0, 15);
}
