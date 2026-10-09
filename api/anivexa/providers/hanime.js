// H-anime provider handler for Anivexa sidecar
// Queries hentaiocean.com API (docs: /api?action=hentai&slug=) +
// embed endpoint /embed/<slug> + hstream.moe + hanime.tv by title slug.

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

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    console.log(`[hanime] ${res.status} ${url}`);
    if (!res.ok) return null;
    return await res.text();
  } catch (e) {
    console.log(`[hanime] fetch error ${url}: ${e.message}`);
    return null;
  }
}

async function tryHentaiOceanAPI(slug) {
  const url = `${HENTAIOCEAN_API}?action=hentai&slug=${encodeURIComponent(slug)}`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const info = json?.info?.[0];
    if (!info) return null;
    // Use embed endpoint for stream (docs show /embed/<slug>)
    const embedUrl = `${HENTAIOCEAN_EMBED}/${info.urlname}`;
    const embedHtml = await fetchText(embedUrl);
    if (embedHtml) {
      const streams = extractStreams(embedHtml, HENTAIOCEAN_EMBED);
      if (streams.length > 0) return streams;
    }
    return null;
  } catch (e) {
    console.log(`[hanime] hentaiocean api error: ${e.message}`);
    return null;
  }
}

async function tryHentaiOcean(slugs) {
  // hentaiocean offers iframe embed player (/embed/{slug}) with direct streams
  for (const slug of slugs) {
    const streams = await tryHentaiOceanAPI(slug);
    if (streams) return streams;
  }
  return null;
}

function extractStreams(html, base) {
  const streams = [];
  const seen = new Set();

  // <source> or <video src>
  const srcRegex = /<(?:source|video)[^>]+src=["']([^"']+)["']/gi;
  let m;
  while ((m = srcRegex.exec(html)) !== null) {
    let url = m[1];
    if (url.startsWith("/")) url = `${base}${url}`;
    if (seen.has(url)) continue;
    if (url.includes(".m3u8")) {
      seen.add(url);
      streams.push({ url, type: "hls", quality: "auto", audio: "sub", server: "hanime", referer: base });
    } else if (/\.(mp4|webm|mkv)/i.test(url)) {
      seen.add(url);
      streams.push({ url, type: "mp4", quality: "auto", audio: "sub", server: "hanime", referer: base });
    }
  }

  // JSON-LD
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = jsonLdRegex.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const videos = Array.isArray(data) ? data : [data];
      for (const v of videos) {
        const url = v?.contentUrl || v?.embedUrl || v?.url;
        if (typeof url === "string") {
          let full = url.startsWith("/") ? `${base}${url}` : url;
          if (seen.has(full)) continue;
          if (full.includes(".m3u8")) {
            seen.add(full);
            streams.push({ url: full, type: "hls", quality: "auto", audio: "sub", server: "hanime", referer: base });
          } else if (/\.(mp4|webm)/i.test(full) || full.includes("embed")) {
            seen.add(full);
            streams.push({ url: full, type: "mp4", quality: "auto", audio: "sub", server: "hanime", referer: base });
          }
        }
      }
    } catch {}
  }

  // iframe embeds
  const iframeRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
  while ((m = iframeRegex.exec(html)) !== null) {
    let url = m[1];
    if (url.startsWith("/")) url = `${base}${url}`;
    if (seen.has(url)) continue;
    if (url.includes("player") || url.includes("embed") || url.includes("stream")) {
      seen.add(url);
      streams.push({ url, type: "embed", quality: "auto", audio: "sub", server: "hanime-embed", referer: base });
    }
  }

  // Aggressive stream extraction: scripts, inline URLs, JSON
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m2;
  while ((m2 = scriptRegex.exec(html)) !== null) {
    const s = m2[1];
    const urlMatch = s.match(/(?:https?:\/\/[^"'\s]+\.(?:m3u8|mp4)(?:[^"'\s]*))/g);
    if (urlMatch) {
      for (const raw of urlMatch) {
        const url = raw.replace(/["'`]/g, '').trim();
        if (url && url.includes('http') && !seen.has(url)) {
          seen.add(url);
          streams.push({ url, type: url.includes('.m3u8') ? 'hls' : 'mp4', quality: 'auto', audio: 'sub', server: 'hanime', referer: base });
        }
      }
    }
  }

  // m3u8/mp4 in scripts (quoted strings)
  const m3u8Regex = /["'](https?:\/\/[^"']*?\.m3u8[^"']*)["']/g;
  while ((m = m3u8Regex.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      streams.push({ url: m[1], type: "hls", quality: "auto", audio: "sub", server: "hanime", referer: base });
    }
  }
  const mp4Regex = /["'](https?:\/\/[^"']*?\.mp4[^"']*)["']/g;
  while ((m = mp4Regex.exec(html)) !== null) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      streams.push({ url: m[1], type: "mp4", quality: "auto", audio: "sub", server: "hanime", referer: base });
    }
  }

  return streams;
}

async function tryHtmlSites(slugs, episode) {
  // Confirmed working patterns from user docs/logs
  const targets = [
    // hanime.tv: slug without "-the-animation" + episode number
    { base: HANIME_BASE, url: `${HANIME_BASE}/videos/hentai/${slugs[0].replace(/-the-animation$/, '')}-${episode}` },
    // hstream.moe: slug with suffix kept + episode number
    { base: HSTREAM_BASE, url: `${HSTREAM_BASE}/hentai/${slugs[0]}-${episode}` },
  ];
  // Also try base variants from slugs array
  for (const s of slugs.slice(0, 6)) {
    targets.push({ base: HSTREAM_BASE, url: `${HSTREAM_BASE}/hentai/${s}-${episode}` });
    targets.push({ base: HANIME_BASE, url: `${HANIME_BASE}/videos/hentai/${s}-${episode}` });
  }
    for (const { base, url } of targets) {
      console.log(`[hanime] probing: ${url}`);
      const html = await fetchText(url);
      if (!html) continue;
      if (!html.includes("<video") && !html.includes("player") && !html.includes("embed") && !html.includes(".m3u8") && !html.includes(".mp4")) {
        console.log(`[hanime] page exists but no video markers: ${url}`);
        continue;
      }
      const streams = extractStreams(html, base);
      if (streams.length > 0) {
        console.log(`[hanime] found ${streams.length} streams from ${url}`);
        return streams;
      }
      // Page loads but no raw .m3u8/.mp4 in HTML — return page as embed/player
      console.log(`[hanime] page valid, returning embed url: ${url}`);
      return [{ url, type: 'embed', quality: 'auto', audio: 'sub', server: 'hanime', referer: base }];
    }
  return null;
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

      // Try hentaiocean first (proper API)
      let streams = await tryHentaiOcean(slugs);
      if (!streams) {
        console.log(`[hanime] hentaiocean failed, trying hstream/hanime...`);
        streams = await tryHtmlSites(slugs, Number(ep));
      }

      if (!streams || streams.length === 0) {
        throw new Error(`No streams found for ${title} ep=${ep}`);
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