# KitaWatch Discord ↔ GitHub feedback bot

Standalone Node.js service. It is intentionally separate from the Tauri desktop app and its release workflow.

## Current scope

- Watches one configured Discord forum channel.
- New forum posts receive moderator-only Approve / Reject buttons.
- Approval creates one GitHub issue and stores the Discord thread ↔ issue mapping in SQLite.
- Discord comments on approved threads are mirrored to GitHub; GitHub issue comments are mirrored to Discord.
- GitHub issue close/reopen webhooks update the Discord thread status where configured.
- Webhook signatures are verified and event delivery IDs are deduplicated.

## Requirements

- Node.js 20+
- A Discord bot invited to the server with View Channels, Send Messages, Read Message History, Manage Threads (for status/archive actions), and Use Application Commands if slash commands are added later.
- Enable the **Message Content Intent** in the Discord Developer Portal.
- Create a **Forum Channel** in a Community-enabled Discord server (not a regular text channel). Create optional forum tags such as `Pending`, `Approved`, `Rejected`, and `Resolved`, then copy their IDs into the matching environment variables.
- Give the bot role these channel permissions on that forum and its threads: **View Channel**, **Send Messages in Threads**, **Read Message History**, and **Manage Threads**. Manage Threads is needed to change tags and archive/unarchive posts. Avoid granting Administrator.
- Create a dedicated moderator role and put its role ID in `DISCORD_MODERATOR_ROLE_IDS` (comma-separated for multiple roles). Members with this role can approve/reject; ordinary members cannot.
- A GitHub fine-grained personal access token restricted to `F0xyN0xy/KitaWatch`, with Issues read/write.
- A publicly reachable HTTPS endpoint for GitHub webhooks.
- Persistent storage for the SQLite database. Do not use an ephemeral directory: losing the database loses the mapping and deduplication state.

## Configure

1. Copy `.env.example` to `.env` and fill in the values. Never commit `.env`.
2. In Discord Developer Mode, copy the server, forum channel, and moderator role IDs.
3. Create a GitHub webhook for `issues` and `issue_comment` events, pointing to `https://YOUR-DOMAIN/webhooks/github`. Choose **application/json** and use the same random secret as `GITHUB_WEBHOOK_SECRET`.
4. In WispByte, select Node.js, set the service's startup command to `npm start` after building, and set environment variables in the host's secret/config panel. Build with `npm install && npm run build`.
5. Set `DATABASE_PATH` to a path on persistent storage and confirm WispByte forwards its public HTTPS domain to the process port.

For local development:

```sh
npm install
cp .env.example .env
npm run dev
```

## Diagnostics

The service logs structured JSON lines to stdout/stderr, including startup checks, Discord gateway connection, permission checks, webhook receipt/signature failures, comment sync failures, and GitHub API errors. Never include bot tokens or webhook secrets in logs.

- `GET /health` is a minimal health endpoint.
- `GET /diagnostics` is disabled (404) unless `DIAGNOSTICS_TOKEN` is set. When enabled, call it with `Authorization: Bearer YOUR_DIAGNOSTICS_TOKEN`. It checks SQLite writes, Discord connection/forum permissions, and GitHub repository access. The endpoint does not return credentials; keep the diagnostics token private.
- In WispByte, inspect the service console/logs first. If startup fails, check missing environment variables, Node.js version, native dependency installation for `better-sqlite3`, and the configured persistent database path.

## Important hosting checks

Before enabling the GitHub webhook, confirm WispByte provides both (a) a persistent writable path for SQLite and (b) inbound HTTPS routing to the process's `PORT`. A domain alone does not guarantee inbound webhooks work. If either is unavailable, use a managed PostgreSQL database or a host with persistent storage and public HTTP ingress.

## Security and behavior

- Only the configured forum is processed.
- Only members with one of the configured moderator roles can approve/reject.
- The original Discord post becomes the GitHub issue body and includes a link back to the forum thread.
- Comments are mirrored only after approval. Bot-generated mirror messages are marked and ignored on the return path to avoid loops.
- The service does not edit GitHub issue descriptions when the Discord starter post is edited.
- Keep the GitHub token and webhook secret private. Use the narrowest token permissions possible.
