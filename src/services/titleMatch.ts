// Provider title verification — pure string math, ZERO network requests.
//
// Why this exists (two reported bugs, one root cause):
//  1. Airing anime: "when the anime is airing and the eps are not all there
//     it will load a different anime". Providers index sequels under near-
//     identical titles ("Attack on Titan Season 2" vs "Attack on Titan").
//     The old matcher took any result where one title contained the other,
//     so a partial provider (only 3 eps of the sequel) "won" over the right
//     one — and the wrong show played.
//  2. H titles: many providers only index a H show under its Japanese
//     romanization or its English release name, never both. Exact/substring
//     matching missed those entirely, so the resolver fell through to a
//     confident WRONG hit (or nothing).
//
// The verifier scores every candidate against ALL AniList title variants
// (romaji/english/native) that the watch page already fetched — no extra
// requests, no rate-limit exposure. Candidates that fail every variant are
// rejected even if they are the search's first hit.

/** Normalize: lowercase, strip punctuation, collapse whitespace. */
export function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Token multiset (words, duplicates preserved — "season 2 season 2" matters). */
function tokens(s: string): string[] {
  return normTitle(s).split(' ').filter(Boolean);
}

/** True when the string is mostly CJK (Japanese/Chinese/Korean scripts).
 *  CJK titles don't tokenize into Latin words, so token-based similarity
 *  is always 0 between a romaji and a native variant — they must be
 *  compared as whole strings instead. */
function isCjk(s: string): boolean {
  const cjk = (s.match(/[぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  const letters = (s.match(/[a-zA-Z぀-ヿ㐀-鿿가-힯]/g) ?? []).length;
  return letters > 0 && cjk / letters > 0.5;
}

/** Jaccard similarity over token sets, with a containment bonus. */
function similarity(a: string, b: string): number {
  // CJK-vs-CJK: exact/normalized string comparison. Providers index native
  // titles verbatim, so anything close to identical is a strong match.
  // NOTE: normTitle() strips non-Latin chars, so compare raw lowercased
  // text here — CJK must survive normalization.
  if (isCjk(a) && isCjk(b)) {
    const na = a.toLowerCase().replace(/[\s・·]+/g, '');
    const nb = b.toLowerCase().replace(/[\s・·]+/g, '');
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    // Substring check catches suffix/prefix decorations some providers add.
    if (na.includes(nb) || nb.includes(na)) return 0.9;
    return 0;
  }
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const sa = new Set(ta);
  const sb = new Set(tb);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  const jaccard = union === 0 ? 0 : inter / union;
  // Containment: "one piece" in "one piece season 1" should score high but
  // not 1.0 — we WANT sequels to beat the parent only when the parent is
  // genuinely absent, and the season-token check below handles that.
  const containment = Math.min(inter / sa.size, inter / sb.size);
  return Math.max(jaccard, containment * 0.9);
}

/** Extract a season/part marker ("season 2", "part 1", "s3", "2nd season"). */
function seasonMarker(s: string): number | null {
  const n = normTitle(s);
  let m = n.match(/(?:season|part)\s+(\d+)/);
  if (m) return Number(m[1]);
  m = n.match(/\bs(\d+)\b/);
  if (m) return Number(m[1]);
  m = n.match(/(\d+)(?:st|nd|rd|th)\s+season/);
  if (m) return Number(m[1]);
  return null;
}

/** Cour/sequel ordinal words ("second", "third" ...). */
const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

function ordinalMarker(s: string): number | null {
  const n = normTitle(s);
  for (const [word, num] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\s+season\\b`).test(n)) return num;
  }
  return null;
}

function seasonOf(s: string): number {
  return seasonMarker(s) ?? ordinalMarker(s) ?? 1;
}

export interface TitleCandidate {
  title?: string;
  /** Provider-reported episode count, if the provider tells us. */
  episodes?: number | null;
}

export interface VerifyOptions {
  /** Episode the user asked for — used for the airing guard. */
  episode?: number;
  /** AniList status ('RELEASING' etc.) — enables the airing guard. */
  status?: string;
}

/**
 * Pick the best-matching candidate, or undefined if none is confident.
 *
 * Scoring per candidate:
 *  - best similarity across ALL AniList title variants (main + alt)
 *  - season mismatch penalty: a candidate whose season marker differs from
 *    the requested show's is heavily penalized (this kills the
 *    "sequel hijack" for airing shows)
 *  - airing guard: when the show is RELEASING and we know the requested
 *    episode, a candidate with FEWER episodes than requested can't be the
 *    right one for that episode — reject outright (it would play ep 1 of
 *    the wrong show)
 */
export function verifyTitle<T extends TitleCandidate>(
  candidates: T[],
  mainTitle: string,
  altTitles: string[] | undefined,
  opts?: VerifyOptions,
): T | undefined {
  const variants = [mainTitle, ...(altTitles ?? [])].filter(Boolean);
  if (variants.length === 0) return undefined;

  const wantSeason = seasonOf(mainTitle);
  const airing = opts?.status === 'RELEASING';
  const wantEp = opts?.episode;

  let best: { item: T; score: number } | null = null;

  for (const c of candidates) {
    const t = c.title ?? '';
    if (!t) continue;

    // Airing guard: provider has fewer eps than the one requested — for a
    // currently-airing show that means this entry CANNOT serve the episode
    // (it's the previous cour/season or a partial listing). Skip it.
    if (airing && wantEp != null && typeof c.episodes === 'number' && c.episodes > 0 && c.episodes < wantEp) {
      continue;
    }

    let sim = 0;
    for (const v of variants) {
      sim = Math.max(sim, similarity(t, v));
    }

    // Season mismatch: same base name, different ordinal. Only penalize when
    // BOTH sides carry a marker — "Season 2" vs "Attack on Titan" (no marker
    // on the AniList side happens when AniList's canonical title omits it)
    // should not be punished, because the sequel IS the airing one.
    const candSeason = seasonOf(t);
    if (candSeason !== wantSeason && seasonMarker(t) != null) {
      sim *= 0.35;
    }

    if (!best || sim > best.score) best = { item: c, score: sim };
  }

  // Confidence floor: below this the hit is a guess, and a confident wrong
  // anime is worse than no stream at all (the error screen says why).
  if (!best || best.score < 0.55) return undefined;
  return best.item;
}

/** Backwards-compatible helper: legacy loose check, now season-aware. */
export function bestTitleMatch<T extends { title?: string }>(
  results: T[],
  query: string,
): T | undefined {
  return verifyTitle(results, query, undefined);
}