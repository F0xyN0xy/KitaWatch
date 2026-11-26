# KitaWatch Status API

The status API serves the public status page and collects monitoring snapshots independently of GitHub Actions.

## Current production architecture

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
2. Apply `supabase/migrations/20261126180000_reconcile_status_monitor_removals.sql`.
3. Create a Vault secret named `kitawatch_status_collector_token` containing the same random value configured as Render's `STATUS_COLLECTOR_TOKEN`.
4. Run `supabase/operations/status-collector-cron.sql` in the Supabase SQL editor to schedule the five-minute collector.

The tables have RLS enabled and no public policies. The RPC functions are executable only by `service_role`.

## Monitor inventory reconciliation

Each successful collector payload is treated as the complete monitor inventory. The database validates the whole non-empty snapshot before reconciling `status_monitor_current`:

- Present monitors are inserted or updated.
- Monitors missing from the validated snapshot are removed from the current inventory.
- Historical samples and incidents are retained, but deleted monitors are excluded from public current status, daily history, and incident output.
- Empty, oversized, malformed, or duplicate-ID snapshots fail without clearing the current inventory.

This prevents a removed monitor from remaining on the status page indefinitely while preserving useful history.

## Endpoints

- `GET /health` — service health check.
- `GET /api/status` — public status payload.
- `POST /api/collect` — protected collector endpoint; requires `Authorization: Bearer <STATUS_COLLECTOR_TOKEN>`.

## History semantics

The production collector currently records one snapshot every five minutes. Daily bars and 30-day uptime are sampled estimates, not individual upstream checks or exact incident durations. Estimated downtime counts each recorded degraded/outage sample as one five-minute interval. If the latest successful snapshot is older than 15 minutes, the displayed current status becomes `unknown`.

UptimeRobot's Free API limit is 10 requests per minute. The collector requests the monitor list once per run (and follows pagination only if the account has more than one page).

## Response-time / cold-start note

The static status frontend is served independently, but its data endpoint is a Render web service. A Free Render web service can spin down after 15 minutes without inbound traffic and may take about a minute to start again. A short in-process cache does not remove that cold-start delay. Verify the actual Render service plan before treating the endpoint as production-stable.

## Uptime Kuma evaluation (side-by-side, not production cutover)

A separate Docker Compose trial lives in `monitoring/uptime-kuma/`. It uses the official `louislam/uptime-kuma:2` stable-major image tag and a named persistent volume.

The trial is intentionally separate from production UptimeRobot collection. Uptime Kuma advertises HTTP(S), keyword, JSON-query, TCP, DNS, Ping, and WebSocket monitors and 20-second intervals. Configure a 60-second interval for the initial comparison.

Important integration constraints:

- Uptime Kuma's public status page caches for five minutes and refreshes every five minutes; it is not the low-latency KitaWatch status frontend.
- Uptime Kuma's internal Socket.IO / status-page APIs are explicitly documented as unsupported for third-party integrations. Do not make production status depend on them.
- Keep the KitaWatch status frontend and Supabase data contract. Promote Kuma only after a supported, tested data-ingestion path and a persistent always-on host are selected.
- Do not deploy the trial on a free Render web service: free services sleep and have ephemeral filesystems, while Kuma requires persistent local storage for its SQLite data.
