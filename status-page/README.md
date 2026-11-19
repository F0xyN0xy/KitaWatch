# KitaWatch Status Page

The status page is a static GitHub Pages frontend. Current service health is loaded from the KitaWatch Status API hosted on Render. A scheduled GitHub Actions job stores one hourly snapshot so the page can build a 30-day history without inventing past results.

## Architecture

- Current service state: KitaWatch Status API.
- Historical bars: hourly snapshots stored in `status-page/data/history.json`.
- Frontend: static GitHub Pages site.

The API credential stays in the Render environment as `UPTIMEROBOT_API_KEY`. It must never be committed to this repository or exposed in frontend code.

## Status API

- `GET /health` — Render health check.
- `GET /api/status` — normalized current monitor status, uptime statistics, and available incident data.

The API caches successful responses for five minutes. The free API limit is 10 requests/minute, so detailed per-monitor statistics are intentionally limited. See the `status-api/` directory for implementation details.

## Uptime history

The scheduled workflow runs hourly, reads the current status API response, and appends a timestamped snapshot to `status-page/data/history.json`. It retains approximately 30 days of samples (up to 750 records).

The 30 daily bars summarize the samples actually recorded for each calendar day:
- Green: all recorded samples were operational.
- Yellow: at least one recorded sample was degraded and none were down.
- Red: at least one recorded sample was down.
- Gray: no samples were recorded.

The 30-day percentage is calculated from recorded hourly snapshots, not presented as a full historical uptime guarantee. History begins accumulating after this workflow is enabled; older days without stored snapshots remain gray.

## Deployment

The same workflow records history on its hourly schedule and deploys the static site to GitHub Pages. Manual workflow dispatch also records a snapshot and deploys. Normal pushes to `status-page/**` validate and deploy the site.
