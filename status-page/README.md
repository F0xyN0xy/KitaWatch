# KitaWatch Status Page

The status page is a static GitHub Pages frontend. Monitoring data is served by the Node.js API on Render and stored in the existing KitaWatch Supabase project.

## Architecture

```text
UptimeRobot (5-minute checks)
          |
          | API v3
          v
Render Status API <----- Supabase Cron (every 5 minutes)
          |
          | private RPC
          v
Supabase PostgreSQL
          |
          | GET /api/status
          v
GitHub Pages status page
```

UptimeRobot's read-only API key, Supabase service-role key, and collector token are server-side secrets. They must never be added to this repository or frontend code.

## Render API

The Render service is configured with:

- Repository: this KitaWatch repository
- Branch: `feature/status-supabase-polling` during rollout; switch to `main` after merging.
- Build command: `npm install --omit=dev --prefix status-api`
- Start command: `npm start --prefix status-api`
- Region: Frankfurt
- Plan: Free

Required environment variables are documented in [status-api/README.md](../status-api/README.md).

Endpoints:

- `GET /health` — Render health check.
- `GET /api/status` — public normalized status, daily history, and incidents.
- `POST /api/collect` — private collector endpoint called by Supabase Cron.

## History semantics

Supabase stores one snapshot per monitor every five minutes. The 30-day uptime percentage and daily bars are calculated from those samples. They are sampled estimates, not UptimeRobot's individual raw checks or exact incident durations. Estimated downtime counts each recorded degraded/outage sample as one five-minute interval.

If the latest successful snapshot is older than 15 minutes, the current status is shown as unknown instead of presenting stale data as current. Historical bars with no samples are shown as unknown.

## Deployment

GitHub Actions only validates and deploys the static `status-page/` directory. It does not collect monitoring data or commit history files. The independent status API checks run in `.github/workflows/status-api-check.yml`.
