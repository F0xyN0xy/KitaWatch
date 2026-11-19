# KitaWatch Status API

The status API serves the public status page and collects monitoring snapshots independently of GitHub Actions.

## Architecture

- UptimeRobot checks configured monitors on its own schedule.
- Supabase Cron calls `POST /api/collect` every five minutes.
- The Render API fetches the UptimeRobot v3 monitor list and records one timestamped snapshot per monitor in Supabase.
- `GET /api/status` reads the latest status, daily history, and incidents from Supabase.
- GitHub Actions only validates and deploys the static status page.

## Required Render environment variables

Set these on the `kitawatch-status-api` Render web service:

| Variable | Purpose |
| --- | --- |
| `UPTIMEROBOT_API_KEY` | UptimeRobot v3 read-only API key |
| `SUPABASE_URL` | KitaWatch Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service-role key |
| `STATUS_COLLECTOR_TOKEN` | Random secret shared with the Supabase Cron job |

Optional:

- `UPTIMEROBOT_API_BASE` defaults to `https://api.uptimerobot.com/v3`.
- `STATUS_CACHE_TTL_MS` defaults to 30 seconds.

Never put these secrets in the status-page frontend, GitHub source files, or a public issue. The service-role key must remain server-side.

## Supabase setup

1. Apply `supabase/migrations/20261119090000_create_status_monitoring.sql`.
2. Create a Vault secret named `kitawatch_status_collector_token` containing the same random value configured as Render's `STATUS_COLLECTOR_TOKEN`.
3. Run `supabase/operations/status-collector-cron.sql` in the Supabase SQL editor to schedule the five-minute collector.

The migration enables `pg_cron` and `pg_net`, creates private tables with RLS enabled and no public policies, and grants the RPC functions only to `service_role`.

## Endpoints

- `GET /health` — service health check.
- `GET /api/status` — public status payload.
- `POST /api/collect` — protected collector endpoint; requires `Authorization: Bearer <STATUS_COLLECTOR_TOKEN>`.

The collector refuses empty monitor lists so a temporary API response problem cannot silently erase the current status.

## History semantics

The collector records one snapshot every five minutes. Daily bars and 30-day uptime are calculated from these stored samples. They are sampled estimates, not UptimeRobot's individual raw checks or exact incident durations. Estimated downtime counts each recorded degraded/outage sample as one five-minute interval. If the latest successful snapshot is older than 15 minutes, the displayed current status becomes `unknown`.

UptimeRobot's Free API limit is 10 requests per minute. The collector requests the monitor list once per run (and follows pagination only if the account has more than one page).
