# KitaWatch Status Page

The status page is a static GitHub Pages frontend. Live monitoring data is retrieved from the separate Node.js API in `status-api/`, which reads monitor information from UptimeRobot API v3.

## Architecture

```text
UptimeRobot monitors
        |
        | API v3 (read-only token)
        v
KitaWatch Status API (Render)
        |
        | cached JSON
        v
KitaWatch Status Page (GitHub Pages)
```

The UptimeRobot token is stored only as the `UPTIMEROBOT_API_KEY` environment variable on the Render service. It must never be added to this repository or frontend code.

## Deploying the API to Render

Create a Node.js web service from this repository using:

- Branch: `feature/uptimerobot-status-integration` during initial testing; switch to `main` after merging.
- Build command: `npm install --omit=dev --prefix status-api`
- Start command: `npm start --prefix status-api`
- Region: Frankfurt
- Plan: Free
- Environment variable: `UPTIMEROBOT_API_KEY` = a UptimeRobot read-only API key

The service exposes:

- `GET /health` — Render health check.
- `GET /api/status` — normalized monitor status and available incident data.

The API caches successful responses in memory for 60 seconds to reduce calls to UptimeRobot. Free Render instances may sleep when idle, so the first request after inactivity can take longer. In-memory cache is not persistent and is not used as historical storage.

## Uptime data limitations

Current monitor states come from UptimeRobot. Uptime percentages are displayed only when the API response includes a supported uptime field. The daily sample bars from the previous GitHub Actions implementation are intentionally not fabricated; the current integration does not recreate them. Incident history is displayed when the account/API response makes it available.

## Status page deployment

GitHub Actions only validates and deploys the static `status-page/` directory. It no longer runs hourly checks or commits monitoring snapshots. The separate `status-page-check.yml` workflow continues to validate changes in pull requests.
