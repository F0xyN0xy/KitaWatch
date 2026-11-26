# Uptime Kuma evaluation

This is a side-by-side evaluation environment, not yet the production monitoring source.

## Start

Requires Docker Engine with the Compose plugin.

```powershell
docker compose up -d
```

Open `http://localhost:3001` and complete the initial administrator setup. Keep the instance private until authentication and HTTPS are configured.

## Initial monitor profile

Use a 60-second interval for the comparison with the current UptimeRobot setup. Start with low-cost liveness and semantic checks:

| Monitor | Type | Expected result |
| --- | --- | --- |
| KitaWatch API | HTTP JSON Query | `/health` returns JSON with `status = healthy` |
| Kuhi adapter | HTTP JSON Query | `/providers/unified/status` confirms Kuhi is registered and configured |
| Anivexa API | HTTP | Root endpoint returns successful JSON |
| KitaWatch Status API | HTTP JSON Query | `/health` returns JSON with `status = healthy` |

Use keyword checks only where a stable, documented response phrase exists. Prefer JSON-query checks for structured health responses.

## Data and hosting

- The named volume stores Kuma's data under `/app/data`; do not replace it with ephemeral container storage.
- The upstream project warns against NFS for its data directory because SQLite needs reliable filesystem locking.
- This Compose file is for a persistent Docker host. It is not a suitable production deployment on Render Free: that plan sleeps after inactivity and does not provide persistent disks.
- Before public exposure, put it behind HTTPS and keep the administrator interface protected.

## Integration decision

Do not scrape Kuma's internal Socket.IO events or undocumented endpoints for production. The upstream wiki labels its internal API unsupported for third-party integrations. Kuma's public status page also caches for five minutes and refreshes every five minutes, so it should not replace KitaWatch's own fast status frontend.

For now, compare monitor quality, check interval, false positives, resource usage, and recovery detection side-by-side. Keep UptimeRobot as the production source until a supported ingestion mechanism and always-on host are verified.
