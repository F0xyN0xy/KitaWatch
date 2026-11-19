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

The service is configured with:

- Repository: this KitaWatch repository
- Branch: `feature/uptimerobot-status-integration` during initial testing; switch to `main` after merging.
- Build command: `npm install --omit=dev --prefix status-api`
- Start command: `npm start --prefix status-api`
- Region: Frankfurt
- Plan: Free
- Environment variable: `UPTIMEROBOT_API_KEY` = a UptimeRobot read-only API key

The service exposes:

- `GET /health` — Render health check.
- `GET /api/status` — normalized monitor status, uptime statistics, and available incident data.

The API caches successful responses in memory for five minutes. The UptimeRobot Free API limit is 10 requests/minute. A refresh uses one monitor-list request, up to eight per-monitor uptime-stat requests, and one aggregate incident-log request. Therefore, detailed 30-day statistics are retrieved for at most eight monitors per refresh; additional monitors still show their current status. The cache is not persistent and resets when a sleeping Render instance wakes.

## Uptime data limitations

Current monitor states come from UptimeRobot. Per-monitor 30-day uptime and downtime are read from the UptimeRobot statistics endpoint. The old hourly sample bars are intentionally not fabricated. Incident entries are read from the aggregated UptimeRobot uptime-stat logs when available.

## Status page deployment

GitHub Actions only validates and deploys the static `status-page/` directory. It no longer runs hourly checks or commits monitoring snapshots. The separate `status-page-check.yml` workflow validates the frontend and API JavaScript in pull requests.
