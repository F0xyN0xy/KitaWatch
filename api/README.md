# Local sidecar sources

The current desktop build still starts three local services and bundles
standalone binaries for release builds. Separately, the frontend uses hosted
KitaWatch and Anivexa endpoints for metadata and provider requests. The local
Kuhi and Anivexa processes remain in the startup/build lifecycle for now; this
documentation does not imply that they have already been removed.

| Service | Source location | How it is obtained | Runtime | Port |
|---|---|---|---|---|
| Kuhi API | `api/anime-api/` | Cloned by `npm run setup:api`; ignored by Git | Python 3.12 + FastAPI/uvicorn | 8000 |
| Anivexa | `api/anivexa/` | Tracked in this repository | Node.js | 4000 |
| Playback proxy | `proxy/` | Tracked at repository root | Python 3.12 + FastAPI/httpx | 8001 |

## Development setup

Run:

```bash
npm install
npm run setup:api
npm run setup:anivexa
npm run tauri dev
```

`setup:api` clones the Kuhi fork into the ignored `api/anime-api/` directory
and creates isolated Python environments for Kuhi and the playback proxy.
`setup:anivexa` installs the Node dependencies for the tracked Anivexa source.

The Tauri app starts the local services automatically in development. The
standalone `npm run api` command is available when you want to run Kuhi
separately for debugging.

## Building release sidecars

`npm run build:sidecars` builds the local services into standalone binaries:

- `kitawatch-kuhi-api` — PyInstaller
- `kitawatch-proxy` — PyInstaller
- `kitawatch-anivexa` — `@yao-pkg/pkg`

The binaries are written to `src-tauri/binaries/` and embedded in the Tauri
installers through `bundle.externalBin`. End users do not need Python or Node
installed separately.

The build script installs PyInstaller into each service's isolated Python
environment. Do not add a second global Python dependency installation to CI
or release workflows unless the build process is deliberately changed.

## Refreshing sources

- Kuhi: `npm run setup:api` (set `KITAWATCH_API_UPDATE=1` to pull an existing
  checkout).
- Anivexa: update `api/anivexa/` from its upstream deliberately, then review
  local changes before committing.

Keep the sidecar source directories until the desktop app no longer builds or
starts those local services. A hosted endpoint does not automatically replace
the local sidecar used by the installed desktop app.
