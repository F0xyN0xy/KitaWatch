# KitaWatch Status Page

A static, independently hosted status page. The GitHub Actions workflow checks the public services hourly, stores a rolling 30-day history in `data/status.json`, tracks incidents, and deploys this directory to GitHub Pages.

## Monitored checks

- **KitaWatch API:** `GET /health` must return HTTP 200 and `{"status":"healthy"}`.
- **Kuhi catalogue:** `GET /episodes/unified/154587` must return a unified response with `adapters.kuhi.available === true`.
- **Anivexa:** `GET /episodes/154587` must return an object containing provider catalogue data.

The catalogue checks use a fixed AniList ID as a lightweight canary. They test catalogue availability, not whether every provider can produce a playable stream. The status page intentionally does not make repeated watch/extraction requests.

## Deploy

1. Merge the status-page branch into `main`.
2. In GitHub, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**.
3. Run **Actions → Status page monitoring → Run workflow** once, or wait for the hourly schedule.
4. The workflow publishes the `status-page/` directory.

## Custom domain

After the first successful Pages deployment, set the custom domain to `status.kitawatch.free.nf` in **Settings → Pages**. Configure the DNS record exactly as GitHub Pages instructs for the repository. DNS provider capabilities vary; do not assume a CNAME is available. HTTPS can be enabled after GitHub verifies the domain and provisions its certificate.

Until that DNS and Pages configuration is complete, the site is available only at the GitHub Pages URL shown in the deployment output.

## Uptime calculation and limitations

Checks run once per hour. Uptime percentages are calculated from recorded samples, so they are approximate and have hourly resolution. GitHub-hosted runner delays, skipped scheduled workflows, and the GitHub Pages deployment itself can affect freshness. This is not an external, independent monitoring provider.

An incident is opened when a service transitions from operational to degraded/outage and resolved when the next successful check returns it to operational. Initial state has no incident because there is no prior sample to compare.
