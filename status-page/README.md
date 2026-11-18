# KitaWatch Status Page

A static, independently hosted status page. The GitHub Actions workflow checks the public services hourly, stores a rolling 30-day history in `data/status.json`, tracks incidents, and deploys this directory to GitHub Pages.

## Monitored checks

- **KitaWatch API:** `GET /health` must return HTTP 200 and `{"status":"healthy"}`.
- **Kuhi adapter:** `GET /providers/unified/status` must report that the Kuhi adapter is registered and configured.
- **Anivexa:** `GET /` must return HTTP 200 with a valid JSON object that does not contain an `error` field. This is a process-reachability check, not a test of every streaming provider.

The catalogue/episode endpoints can fan out to external scrapers and take longer than a health check. The status page intentionally does not make repeated watch/extraction requests.

## Uptime calculation and limitations

Checks run once per hour. The uptime percentages are calculated from recorded samples, so they are approximate and have hourly resolution. Daily history bars summarize the samples recorded for each calendar day: red takes precedence over yellow if a day contains both outage and degraded samples. Gray means no sample was recorded for that day. GitHub-hosted runner delays, skipped scheduled workflows, and the GitHub Pages deployment itself can affect freshness. This is not an external, independent monitoring provider.

An incident is opened when a service transitions from operational to degraded/outage and resolved when the next successful check returns it to operational. Initial state has no incident because there is no prior sample to compare.

## Deploy

1. Merge the status-page branch into `main`.
2. In GitHub, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
3. Run **Actions → Status page monitoring → Run workflow** once, or wait for the hourly schedule.
4. The workflow publishes the `status-page/` directory.
