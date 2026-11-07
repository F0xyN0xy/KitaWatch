<div align="center">

# KitaWatch

**A cross-platform desktop anime streaming client — local-first, no central server, automatic updates.**

[![Release](https://img.shields.io/github/v/release/F0xyN0xy/KitaWatch?style=for-the-badge)](https://github.com/F0xyN0xy/KitaWatch/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/F0xyN0xy/KitaWatch/total?style=for-the-badge)](https://github.com/F0xyN0xy/KitaWatch/releases)
[![Build](https://img.shields.io/github/actions/workflow/status/F0xyN0xy/KitaWatch/release.yml?style=for-the-badge&label=BUILD)](https://github.com/F0xyN0xy/KitaWatch/actions/workflows/release.yml)
[![License](https://img.shields.io/badge/PolyForm_NC-1.0-blue?style=for-the-badge)](./LICENSE.md)

[![Platform](https://img.shields.io/badge/Windows-0078D6?style=for-the-badge&logo=windows&logoColor=white)](https://github.com/F0xyN0xy/KitaWatch/releases/latest)
[![Platform](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)](https://github.com/F0xyN0xy/KitaWatch/releases/latest)
[![Tauri](https://img.shields.io/badge/Tauri_2-ffc131?style=for-the-badge&logo=tauri&logoColor=black)](https://v2.tauri.app)
![Auto Update](https://img.shields.io/badge/Updates-Auto-22c55e?style=for-the-badge)

[![Top Language](https://img.shields.io/github/languages/top/F0xyN0xy/KitaWatch?style=for-the-badge)](https://github.com/F0xyN0xy/KitaWatch)
[![Languages](https://img.shields.io/github/languages/count/F0xyN0xy/KitaWatch?style=for-the-badge)](https://github.com/F0xyN0xy/KitaWatch)
[![Code Size](https://img.shields.io/github/languages/code-size/F0xyN0xy/KitaWatch?style=for-the-badge)](https://github.com/F0xyN0xy/KitaWatch)
[![Repo Size](https://img.shields.io/github/repo-size/F0xyN0xy/KitaWatch?style=for-the-badge)](https://github.com/F0xyN0xy/KitaWatch)
[![Last Commit](https://img.shields.io/github/last-commit/F0xyN0xy/KitaWatch?style=for-the-badge)](https://github.com/F0xyN0xy/KitaWatch/commits)
[![Commit Activity](https://img.shields.io/github/commit-activity/m/F0xyN0xy/KitaWatch?style=for-the-badge)](https://github.com/F0xyN0xy/KitaWatch/commits)

[![Stars](https://img.shields.io/github/stars/F0xyN0xy/KitaWatch?style=for-the-badge&logo=github)](https://github.com/F0xyN0xy/KitaWatch/stargazers)
[![Forks](https://img.shields.io/github/forks/F0xyN0xy/KitaWatch?style=for-the-badge&logo=github)](https://github.com/F0xyN0xy/KitaWatch/forks)
[![Issues](https://img.shields.io/github/issues/F0xyN0xy/KitaWatch?style=for-the-badge&logo=github)](https://github.com/F0xyN0xy/KitaWatch/issues)
[![Contributors](https://img.shields.io/github/contributors/F0xyN0xy/KitaWatch?style=for-the-badge&logo=github)](https://github.com/F0xyN0xy/KitaWatch/graphs/contributors)

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![React](https://img.shields.io/badge/React_18-61DAFB?style=for-the-badge&logo=react&logoColor=black)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white)](https://vitejs.dev)
[![Tailwind](https://img.shields.io/badge/Tailwind_v4-38BDF8?style=for-the-badge&logo=tailwindcss&logoColor=white)](https://tailwindcss.com)
[![Rust](https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white)](https://www.rust-lang.org)
[![Python](https://img.shields.io/badge/Python_3.12-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://www.python.org)
[![Node](https://img.shields.io/badge/Node-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)

</div>

---

> **KitaWatch does not host any content.** It is a client for third-party
> sources; all content is provided by external services. Metadata comes from
> the public [AniList](https://anilist.co) API.

## Install

Download the latest installer from
[**Releases**](https://github.com/F0xyN0xy/KitaWatch/releases/latest):

| Platform | Package |
|---|---|
| Windows | `KitaWatch_*_x64-setup.exe` (or `.msi`) |
| Linux | `.deb`, `.rpm`, or `.AppImage` |

Everything is bundled — **no Python, Node, or configuration needed**. The app
spawns its own local backends on first launch (give it ~15 seconds).

**Updates are automatic**: the app checks GitHub Releases on launch and offers
one-click, cryptographically signed updates.

## Features

- Spotlight hero, trending / popular / recently-aired rows
- Instant search with live autocomplete (AniList-direct)
- Episode grids from official AniList data — always complete
- HLS player (HLS.js + ArtPlayer): server selector, auto-failover on stream
  errors, **skip intro/outro** (AniSkip), keyboard shortcuts, autoplay-next,
  subtitles (VTT/SRT), PiP, screenshots
- Resolver chain: Kuhi → Anivexa → AniKage → Consumet → animepahe →
  optional torrent fallback (Nyaa magnets via WebTorrent)
- "Provider availability" probe — see which backends carry any anime
- **"Because you watched…"** recommendations row
- Continue Watching, My List, watch history
- AniList OAuth: favorites sync both ways (you always log in with your own account)
- Virtualized browse grid, genre filtering, dark cinematic UI

## Architecture

```
React 18 + TypeScript + Vite + Tailwind v4      (UI, lazy routes)
        │
        ├─► kitawatch-kuhi-api   (Python 3.12, :8000)  search · metadata · extraction
        ├─► kitawatch-proxy      (Python 3.12, :8001)  CORS relay · referer spoof · m3u8 rewrite · OAuth
        └─► kitawatch-anivexa    (Node,        :4000)  15-provider aggregator
```

All three backends are vendored in [`api/`](./api) and bundled as standalone
binaries — every user runs their own instance locally. There is no central
server. Shell: Tauri v2 (Rust). Updates: minisign-signed.

## Building from source

Prerequisites: Node 18+, Rust toolchain, Python **3.12+**.

```bash
npm install
npm run tauri dev          # development (spawns sidecars from api/ sources)
```

Release builds bundle the sidecars as windowless onefile binaries:

```bash
npm run build:sidecars     # PyInstaller + @yao-pkg/pkg -> src-tauri/binaries
npm run tauri build        # installers -> src-tauri/target/release/bundle/
```

Shipping a release:

```bash
npm run release:tag -- X.Y.Z   # bump, commit, tag, push -> CI builds + signs + publishes
```

## Supabase guest accounts and CAPTCHA

The leaderboard can create a private anonymous Supabase account for a device that
does not already have a KitaWatch session. New guest-account creation is protected
with hCaptcha; existing sessions do not need to solve a challenge again.

To configure it:

1. Create an hCaptcha site and copy its **Sitekey** and **Secret key**.
2. In Supabase, enable anonymous sign-ins under Authentication sign-in providers.
3. In Supabase, open **Authentication → Bot and Abuse Protection**, enable CAPTCHA,
   choose **hCaptcha**, and enter the hCaptcha **Secret key**.
4. Put the public Sitekey in the local build environment as
   `VITE_HCAPTCHA_SITE_KEY=your_sitekey`.
5. Build KitaWatch again so Vite embeds the public sitekey in the app.

The hCaptcha Sitekey is public and may be included in the desktop build. The hCaptcha
Secret key must stay in Supabase's dashboard; never add it to `.env`, frontend
code, or GitHub. Keep hCaptcha domain allowlisting disabled initially unless the
Tauri app's WebView origin and the website host are both correctly allowlisted.

If `VITE_HCAPTCHA_SITE_KEY` is missing, the leaderboard explains that CAPTCHA
is not configured instead of repeatedly attempting an anonymous sign-in.

## Contributing

Issues and pull requests are welcome — see [LICENSE.md](./LICENSE.md)
(free to use, modify, and contribute; commercial use is not permitted).

## Legal

KitaWatch is a client application. It does not host, store, or distribute
video content. You are responsible for complying with the laws of your
jurisdiction. Full disclaimer in-app (Settings → About / Terms / DMCA).

## Acknowledgements

- [Kuhi API](https://github.com/aryaniiil/kuhi-anime-api) — extraction backend
- [Anivexa-API](https://github.com/walterwhite-69/Anivexa-API) — provider aggregator
- [AniList](https://anilist.co) — metadata & OAuth
- [AniKage](https://anikage.cc) — provider API
- [AniSkip](https://aniskip.com) — intro/outro timestamps
- [Consumet](https://github.com/consumet/consumet-api) — optional fallback
