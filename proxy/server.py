from urllib.parse import quote, urlencode, urljoin, urlparse

from curl_cffi.requests import AsyncSession
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

app = FastAPI()

# CORS: any localhost origin may call us (the desktop app). Credentials are
# never involved, so "*" is safe here.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Domains we are willing to fetch on behalf of the app. Suffix match.
# NOTE: the playback routes (proxy_m3u8/proxy_segment) deliberately have NO
# allowlist — provider CDNs rotate nested hosts weekly (megaplay alone has
# burned through a dozen), so host matching there is unwinnable whack-a-mole.
# The allowlist below stays for /cors, /fetch and /kwik, which return
# arbitrary content to the page and still need guarding.
DEFAULT_ALLOWLIST = {
    # metadata / community APIs
    "anikage.cc",
    "kwik.si",
    "animepahe.ru",
    "anilist.co",
    "api.aniskip.com",
    "graphql.anilist.co",
    "ltn.hitomi.la",
    "nyaa.si",
    # providers
    "1anime.app",
    "anify.tv",       # Anify public API (api.anify.tv)
    # local sidecars
    "localhost",
    "127.0.0.1",
    # Provider CDNs (m3u8/subtitle hosts the watch endpoints return; these are
    # referer-locked and CORS-locked, so they only play through us)
    "vid-cdn.xyz",      # anizone (seiryuu.vid-cdn.xyz)
    "bcdn2.se",         # senshi / kickasscdn (s-95.bcdn2.se)
    "bcdn1.se",         # senshi mirrors (s-90.bcdn1.se)
    "animeapps.top",    # anidbapp (playeng.animeapps.top)
    "bakayaro.live",    # anikage (og.bakayaro.live)
    "flixcloud.cc",     # anikage / anikoto mirrors (fetch*.flixcloud.cc)
    "nexabloom.top",    # megaplay family (fetch.nexabloom.top)
    "tyrionx.top",      # megaplay nested segment hosts (tx-*.tyrionx.top)
    "krussdomi.com",    # krussdomi (hls.krussdomi.com)
    "roburnt10.store",  # echovideo (st3.roburnt10.store)
    "r66nv9ed.com",     # gn1r5n / anikage servers (edge*.r66nv9ed.com)
    "mkissa.to",        # mkissa mirror
    "animedunya.in",    # animedunya provider
}

# Optional operator override: comma-separated extra hosts.
import os

ALLOWLIST = DEFAULT_ALLOWLIST | {
    h.strip().lower() for h in os.environ.get("PROXY_ALLOWLIST", "").split(",") if h.strip()
}

# Browser impersonation target (TLS/JA3/HTTP2 fingerprint). Plain clients get
# Cloudflare-403'd by nyaa/animepahe and half the provider CDNs.
# Impersonation profile tried in order — older profiles get flagged by
# Cloudflare over time (chrome124 started 403ing animepahe in Sep 2026),
# so we fall back through the newest profiles the installed curl_cffi has.
BROWSER_PROFILES = ["chrome131", "chrome124", "chrome120"]
BROWSER = BROWSER_PROFILES[0]


def host_allowed(url: str) -> bool:
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    return host in ALLOWLIST or any(host.endswith("." + a) for a in ALLOWLIST)


def _headers(referer: str | None) -> dict[str, str]:
    h = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
        )
    }
    if referer:
        h["Referer"] = referer
    return h


async def _get(url: str, referer: str | None, timeout: float):
    """One browser-impersonated GET. Raises on network errors.

    Tries the impersonation profiles newest-first: the installed curl_cffi
    may not ship the newest profile, and older ones get flagged by
    Cloudflare over time. An invalid profile name raises immediately, so
    we can cheaply probe down the list.
    """
    last_err: Exception | None = None
    for profile in BROWSER_PROFILES:
        try:
            async with AsyncSession(impersonate=profile, timeout=timeout) as client:
                return await client.get(url, headers=_headers(referer))
        except Exception as e:
            last_err = e
            msg = str(e).lower()
            if "impersonate" not in msg and "profile" not in msg:
                raise
    raise last_err or RuntimeError("no impersonation profile available")


@app.get("/cors")
async def cors(u: str = Query(...), ref: str | None = None):
    """Generic CORS-safe fetch: returns the body, streams binary."""
    if not host_allowed(u):
        return JSONResponse({"error": "host not allowed"}, status_code=403)
    try:
        r = await _get(u, ref, 30.0)
    except Exception as e:
        print(f"[proxy error] {e}")
        return JSONResponse({"error": "proxy request failed"}, status_code=502)
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type", "application/octet-stream"),
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
        },
    )


@app.get("/proxy_m3u8")
async def proxy_m3u8(url: str = Query(...), referer: str | None = None):
    """Fetch an m3u8 playlist, rewrite segment URLs through /proxy_segment.

    No host allowlist here (see note above DEFAULT_ALLOWLIST): CDNs rotate
    nested hosts faster than any list can track.
    """
    try:
        r = await _get(url, referer, 30.0)
    except Exception as e:
        print(f"[proxy error] {e}")
        return JSONResponse({"error": "proxy request failed"}, status_code=502)
    if r.status_code != 200:
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type=r.headers.get("content-type", "text/plain"),
        )
    out = _rewrite_playlist(r.text, url, referer)
    return Response(
        content=out,
        media_type="application/vnd.apple.mpegurl",
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
        },
    )


def _rewrite_playlist(text: str, playlist_url: str, referer: str | None) -> str:
    """Rewrite every resource line of an m3u8 through /proxy_segment.

    urljoin resolves absolute, protocol-relative (//host/…), root-relative
    (/…) and plain relative lines correctly. Quote the embedded URL so '&'
    in signed segment URLs (krussdomi ?t=…&s=…&e=…) survives the trip
    through our own query string instead of being parsed as our params.
    """

    def fix(line: str) -> str:
        line = line.strip()
        if not line or line.startswith("#"):
            return line
        seg = urljoin(playlist_url, line)
        return f"/proxy_segment?url={quote(seg, safe=':/')}&referer={quote(referer or '', safe=':/')}"

    return "\n".join(fix(l) for l in text.splitlines())


@app.get("/proxy_segment")
async def proxy_segment(url: str = Query(...), referer: str | None = None):
    """Stream a video segment through us (avoids CDN referer checks).

    Providers chain playlists across hosts (master -> variant -> segments,
    e.g. fetch.nexabloom.top -> tx-05.tyrionx.top). A nested m3u8 variant
    fetched here would otherwise hand hls.js absolute segment URLs that it
    then loads DIRECTLY — and gets referer-403'd. So when the response is a
    playlist, rewrite its segment lines through /proxy_segment as well.

    No host allowlist (see note above DEFAULT_ALLOWLIST).
    """
    try:
        r = await _get(url, referer, 60.0)
    except Exception as e:
        print(f"[proxy error] {e}")
        return JSONResponse({"error": "proxy request failed"}, status_code=502)

    ctype = r.headers.get("content-type", "")
    looks_like_playlist = (
        "mpegurl" in ctype.lower()
        or url.split("?")[0].endswith(".m3u8")
        or r.content[:8].startswith(b"#EXTM3U")
    )
    if looks_like_playlist and r.status_code == 200:
        out = _rewrite_playlist(r.text, url, referer)
        return Response(
            content=out,
            media_type="application/vnd.apple.mpegurl",
            headers={
                "Access-Control-Allow-Origin": "*",
                "Cache-Control": "no-cache",
            },
        )

    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type", "application/octet-stream"),
        headers={
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-cache",
        },
    )


@app.get("/fetch")
async def fetch_url(u: str = Query(...), ref: str | None = None):
    """Passthrough with CORS headers (HTML pages, magnets, etc.)."""
    if not host_allowed(u):
        return JSONResponse({"error": "host not allowed"}, status_code=403)
    try:
        r = await _get(u, ref, 30.0)
    except Exception as e:
        print(f"[proxy error] {e}")
        return JSONResponse({"error": "proxy request failed"}, status_code=502)
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type", "application/octet-stream"),
        headers={"Access-Control-Allow-Origin": "*"},
    )


# animepahe website-API relay. The app's /ap?m=search|release|links calls are
# the animepahe site's own JSON API shape (animepahe.com/api?m=...); the old
# api.animepahe.ru was just a relay mirror of it and is gone. The site is
# Cloudflare-fronted, but our curl_cffi chrome impersonation passes it.
# Official mirrors rotate (.pw/.com/.org) — override via ANIMEPAHE_SITES.
ANIMEPAHE_SITES = [
    s.strip().rstrip("/")
    for s in os.environ.get(
        "ANIMEPAHE_SITES",
        "https://animepahe.com,https://animepahe.org,https://animepahe.pw",
    ).split(",")
    if s.strip()
]


@app.get("/ap")
async def animepahe(
    m: str = Query(...),
    q: str = Query(default=""),
    id: str | None = None,
    sort: str | None = None,
    page: int | None = None,
    p: str | None = None,
):
    """animepahe /api passthrough — forwards every param the app sends
    (m, q, id, sort, page, p) and rotates the official mirrors."""
    params: dict = {"m": m, "q": q}
    if id is not None:
        params["id"] = id
    if sort is not None:
        params["sort"] = sort
    if page is not None:
        params["page"] = page
    if p is not None:
        params["p"] = p
    qs = urlencode(params)
    last_err = "no animepahe mirror responded"
    for base in ANIMEPAHE_SITES:
        try:
            r = await _get(f"{base}/api?{qs}", f"{base}/", 30.0)
        except Exception as e:
            last_err = "animepahe mirror failed"
            print(f"[proxy animepahe error] {e}")
            continue
        # Cloudflare may challenge one mirror but not another — rotate on
        # challenge-ish statuses instead of giving up after the first.
        if r.status_code in (403, 429, 503):
            last_err = f"{base} -> HTTP {r.status_code}"
            continue
        return Response(
            content=r.content,
            status_code=r.status_code,
            media_type="application/json",
            headers={"Access-Control-Allow-Origin": "*"},
        )
    return JSONResponse({"error": last_err}, status_code=502)


@app.get("/kwik")
async def kwik(u: str = Query(...)):
    """kwik link extraction passthrough."""
    if not host_allowed(u):
        return JSONResponse({"error": "host not allowed"}, status_code=403)
    try:
        r = await _get(u, "https://kwik.si/", 30.0)
    except Exception as e:
        print(f"[proxy error] {e}")
        return JSONResponse({"error": "proxy request failed"}, status_code=502)
    return Response(
        content=r.content,
        status_code=r.status_code,
        media_type=r.headers.get("content-type", "text/html"),
        headers={"Access-Control-Allow-Origin": "*"},
    )