// H-anime provider handler for Anivexa sidecar
// Queries hentaiocean.com API (docs: /api?action=hentai&slug=) +
// embed endpoint /embed/<slug> + hstream.moe + hanime.tv by title slug.

import { absoluteHttpUrl, mediaKindFromUrl, frameEmbedPolicy } from "../core/source-type.js";

const HENTAIOCEAN_API = "https://hentaiocean.com/api";
const HENTAIOCEAN_EMBED = "https://hentaiocean.com/embed";

const HENTAIOCEAN_BASE = "https://hentaiocean.com";
const HSTREAM_BASE = "https://hstream.moe";
const HANIME_BASE = "https://hanime.tv";

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[:!?.~,]/g, " ")   // punctuation -> space (NOT empty!)
    .replace(/\s+/g, "-")         // spaces -> hyphens
    .replace(/-+/g, "-")          // collapse multiple hyphens
    .replace(/^-|-$/g, "");       // trim leading/trailing hyphens
}

function buildSlugs(media, episode) {
  const titles = [];
  const t = media?.title || {};
  for (const key of ["english", "romaji", "native"]) {
    if (t[key]) titles.push(t[key]);
  }
  // AniList synonyms field is not fetched; safely handle missing/undefined
  const syns = media?.synonyms;
  if (Array.isArray(syns)) {
    for (const syn of syns) {
      if (syn) titles.push(syn);
    }
  }

  const seen = new Set();
  const slugs = [];
  for (const title of titles) {
    const s = slugify(title);
    if (!s) continue;

    // Build all base variants first
    const bases = [s];
    for (const suffix of ["-the-animation", "-ova", "-special", "-season-1", "-season-2", "-season-3"]) {
      if (s.endsWith(suffix)) {
        const stripped = s.slice(0, -suffix.length);
        if (stripped) bases.push(stripped);
      }
    }
    const noTrail = s.replace(/-\d+$/, "");
    if (noTrail && noTrail !== s) bases.push(noTrail);

    // Add each base + episode variants
    for (const base of bases) {
      if (!seen.has(base)) { seen.add(base); slugs.push(base); }
      const epSlug = `${base}-${episode}`;
      if (!seen.has(epSlug)) { seen.add(epSlug); slugs.push(epSlug); }
      const epSlug2 = `${base}-${String(episode).padStart(2, "0")}`;
      if (!seen.has(epSlug2)) { seen.add(epSlug2); slugs.push(epSlug2); }
      // hentaiocean uses ~ before episode count (per docs/user)
      const oceanSlug = `${base}-~${episode}`;
      if (!seen.has(oceanSlug)) { seen.add(oceanSlug); slugs.push(oceanSlug); }
      const oceanSlug2 = `${base}-~${String(episode).padStart(2, "0")}`;
      if (!seen.has(oceanSlug2)) { seen.add(oceanSlug2); slugs.push(oceanSlug2); }
    }
  }
  return slugs;
}

async function fetchJson(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });
    console.log(`[hanime] ${res.status} ${url}`);
    if (!res.ok) {
      const text = await res.text().catch(() => "(no body)");
      console.log(`[hanime] error body: ${text.substring(0, 200)}`);
      return null;
    }
    const text = await res.text();
    if (!text) {
      console.log(`[hanime] empty body from ${url}`);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      console.log(`[hanime] JSON parse error: ${e.message}`);
      console.log(`[hanime] body preview: ${text.substring(0, 200)}`);
      return null;
    }
  } catch (e) {
    console.log(`[hanime] fetch error: ${e.message}`);
    return null;
  }
}

const PAGE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

/** GET a page; keeps status + headers (needed to judge embeddability). */
async function fetchPage(url) {
  try {
    const res = await fetch(url, { headers: PAGE_HEADERS });
    console.log(`[hanime] ${res.status} ${url}`);
    if (!res.ok) return null;
    return { url, headers: res.headers, text: await res.text() };
  } catch (e) {
    console.log(`[hanime] fetch error ${url}: ${e.message}`);
    return null;
  }
}

// HTTP 200 only proves a page exists. A candidate becomes playable ONLY if
//  (a) it exposes a direct hls/mp4 URL, or
//  (b) it is an embed endpoint whose own response headers allow framing.
// Everything else is recorded in `report` and never returned as a stream.

function pushStream(streams, seen, stream) {
  if (seen.has(stream.url)) return;
  seen.add(stream.url);
  streams.push(stream);
}

/** Direct media URLs exposed by a page (typed from the URL path, never guessed). */
function extractMediaStreams(html, base) {
  const streams = [];
  const seen = new Set();
  const add = (raw) => {
    const url = absoluteHttpUrl(raw, base);
    const type = url && mediaKindFromUrl(url);
    if (!type) return;
    pushStream(streams, seen, { url, type, quality: "auto", audio: "sub", server: "hanime", referer: base });
  };

  let m;
  const srcRegex = /<(?:source|video)[^>]+src=["']([^"']+)["']/gi;
  while ((m = srcRegex.exec(html)) !== null) add(m[1]);

  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      for (const v of Array.isArray(data) ? data : [data]) add(v?.contentUrl);
    } catch { /* malformed JSON-LD */ }
  }

  // Quoted absolute URLs inside inline scripts / JSON blobs.
  const quoted = /["'](https?:\/\/[^"'\s]+?\.(?:m3u8|mp4)(?:\?[^"'\s]*)?)["']/gi;
  while ((m = quoted.exec(html)) !== null) add(m[1]);
  return streams;
}

/** Iframe / JSON-LD embedUrl candidates a page itself declares. */
function extractEmbedCandidates(html, base) {
  const out = new Set();
  let m;
  const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
  while ((m = iframeRegex.exec(html)) !== null) {
    const u = absoluteHttpUrl(m[1], base);
    if (u) out.add(u);
  }
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      for (const v of Array.isArray(data) ? data : [data]) {
        const u = absoluteHttpUrl(v?.embedUrl, base);
        if (u) out.add(u);
      }
    } catch { /* malformed JSON-LD */ }
  }
  return [...out];
}

/** Embed stream for `url` if the provider's headers permit framing; else null (+report). */
async function embedStreamIfAllowed(url, base, report, page, server = "hanime-embed") {
  const res = page ?? (await fetchPage(url));
  if (!res) return null;
  const policy = frameEmbedPolicy(res.headers);
  if (!policy.embeddable) {
    console.log(`[hanime] not embeddable (${policy.reason}): ${url}`);
    report.blocked.push({ url, reason: policy.reason });
    return null;
  }
  return { url, type: "embed", quality: "auto", audio: "sub", server, referer: base };
}

async function tryHentaiOceanAPI(slug, report) {
  const url = `${HENTAIOCEAN_API}?action=hentai&slug=${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return null;
    const json = await res.json();
    const info = json?.info?.[0];
    if (!info?.urlname) return null;
    // /embed/<urlname> is hentaiocean's documented iframe player endpoint.
    const embedUrl = `${HENTAIOCEAN_EMBED}/${info.urlname}`;
    const page = await fetchPage(embedUrl);
    if (!page) return null;
    const media = extractMediaStreams(page.text, HENTAIOCEAN_BASE);
    if (media.length > 0) return media;
    const embed = await embedStreamIfAllowed(embedUrl, HENTAIOCEAN_BASE, report, page, "hentaiocean-embed");
    return embed ? [embed] : null;
  } catch (e) {
    console.log(`[hanime] hentaiocean api error: ${e.message}`);
    return null;
  }
}

async function tryHentaiOcean(slugs, report) {
  for (const slug of slugs) {
    const streams = await tryHentaiOceanAPI(slug, report);
    if (streams) return streams;
  }
  return null;
}

async function tryHtmlSites(slugs, episode, report) {
  const targets = [];
  const seenTargets = new Set();
  const addTarget = (base, url) => {
    if (seenTargets.has(url)) return;
    seenTargets.add(url);
    targets.push({ base, url });
  };
  // hanime.tv: slug without "-the-animation" + episode number
  addTarget(HANIME_BASE, `${HANIME_BASE}/videos/hentai/${slugs[0].replace(/-the-animation$/, "")}-${episode}`);
  // hstream.moe: slug with suffix kept + episode number
  addTarget(HSTREAM_BASE, `${HSTREAM_BASE}/hentai/${slugs[0]}-${episode}`);
  for (const s of slugs.slice(0, 6)) {
    addTarget(HSTREAM_BASE, `${HSTREAM_BASE}/hentai/${s}-${episode}`);
    addTarget(HANIME_BASE, `${HANIME_BASE}/videos/hentai/${s}-${episode}`);
  }

  for (const { base, url } of targets) {
    console.log(`[hanime] probing: ${url}`);
    const page = await fetchPage(url);
    if (!page) continue; // 404 / network error: candidate doesn't exist

    const media = extractMediaStreams(page.text, base);
    if (media.length > 0) {
      console.log(`[hanime] found ${media.length} direct streams from ${url}`);
      return media;
    }

    // The watch page itself is NOT an embed. Only a frame the page declares,
    // and only if that frame's own headers allow it.
    const embeds = [];
    for (const candidate of extractEmbedCandidates(page.text, base)) {
      const e = await embedStreamIfAllowed(candidate, base, report);
      if (e) embeds.push(e);
    }
    if (embeds.length > 0) return embeds;

    // Page exists but gives us nothing playable. If it also forbids framing,
    // say so explicitly (this is the hstream.moe case).
    const policy = frameEmbedPolicy(page.headers);
    report.pages.push({ url, reason: policy.embeddable ? "no direct media or embed found" : policy.reason });
    if (!policy.embeddable) report.blocked.push({ url, reason: policy.reason });
  }
  return null;
}


// Playback preference, best first. Direct hls/mp4 plays in ArtPlayer with no
// third-party ad stack; a provider embed runs the site's whole player (and its
// ads). hentaiocean's embed is the ad-heavy one, so it is the last resort.
function streamRank(s) {
  if (s.type !== "embed") return 0;                    // direct media, any provider
  if (s.server === "hentaiocean-embed") return 2;      // ad-heavy embed: last
  return 1;                                            // other providers' embeds
}
function orderStreams(streams) {
  return [...streams].sort((a, b) => streamRank(a) - streamRank(b)); // stable
}

async function getMedia(anilistId) {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ANIME) {
        id
        title { english romaji native }
        episodes
      }
    }
  `;
  const res = await fetch("https://graphql.anilist.co", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query, variables: { id: Number(anilistId) } }),
  });
  if (!res.ok) throw new Error(`AniList ${res.status}`);
  const json = await res.json();
  return json?.data?.Media;
}

export { extractMediaStreams, extractEmbedCandidates, buildSlugs, slugify };

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/watch\/hanime\/(\d+)\/(sub|dub)\/hanime-(\d+)\/?$/);
    if (!m) {
      return new Response(JSON.stringify({ error: "invalid hanime route" }), { status: 400 });
    }

    const [, anilistId, audio, ep] = m;
    console.log(`[hanime] watch: anilistId=${anilistId} ep=${ep}`);

    try {
      const media = await getMedia(anilistId);
      if (!media) throw new Error(`No AniList media for ${anilistId}`);

      const title = media.title?.english || media.title?.romaji || "unknown";
      console.log(`[hanime] title: ${title}`);

      const slugs = buildSlugs(media, Number(ep));
      console.log(`[hanime] ${slugs.length} slug candidates`);

      const report = { blocked: [], pages: [] };

      // Query hstream/hanime.tv and hentaiocean concurrently (no extra latency),
      // then order: direct media -> other embeds -> hentaiocean embed LAST.
      const [others, ocean] = await Promise.all([
        tryHtmlSites(slugs, Number(ep), report),
        tryHentaiOcean(slugs, report),
      ]);
      const seenUrls = new Set();
      const streams = orderStreams([...(others ?? []), ...(ocean ?? [])]).filter(
        (s) => (seenUrls.has(s.url) ? false : (seenUrls.add(s.url), true)),
      );

      if (!streams || streams.length === 0) {
        // Pages that exist but aren't playable (deduped by URL).
        const unplayable = [...report.pages, ...report.blocked].filter(
          (p, i, all) => all.findIndex((q) => q.url === p.url) === i,
        );
        if (unplayable.length > 0) {
          // Say why instead of faking a stream.
          const why = unplayable.map((p) => `${new URL(p.url).host}: ${p.reason}`).join("; ");
          return new Response(
            JSON.stringify({ error: `Hanime: found ${title} ep=${ep} but it cannot be played in-app (${why}). No provider-supported embed or direct media available.`, unsupported: unplayable }),
            { status: 422, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
          );
        }
        throw new Error(`No page found for ${title} ep=${ep}`);
      }

      console.log(`[hanime] returning ${streams.length} streams`);
      return new Response(JSON.stringify({ streams, sources: streams }, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch (e) {
      console.error(`[hanime] error:`, e);
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};