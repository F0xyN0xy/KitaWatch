import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import Database from "better-sqlite3";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Message,
  ThreadChannel,
} from "discord.js";

const required = [
  "DISCORD_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_FORUM_CHANNEL_ID",
  "GITHUB_REPOSITORY",
  "GITHUB_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
] as const;
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
}

const env = process.env;
const startedAt = new Date().toISOString();
function log(level: "info" | "warn" | "error", event: string, details: Record<string, unknown> = {}) {
  const entry = { timestamp: new Date().toISOString(), level, event, ...details };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const repo = env.GITHUB_REPOSITORY!;
const [owner, repoName] = repo.split("/");
if (!owner || !repoName || repo.split("/").length !== 2) {
  throw new Error("GITHUB_REPOSITORY must be owner/repo");
}
const moderatorRoles = new Set(
  (env.DISCORD_MODERATOR_ROLE_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean),
);
const pendingTag = env.DISCORD_PENDING_TAG_ID;
const approvedTag = env.DISCORD_APPROVED_TAG_ID;
const rejectedTag = env.DISCORD_REJECTED_TAG_ID;
const resolvedTag = env.DISCORD_RESOLVED_TAG_ID;
const dbPath = path.resolve(env.DATABASE_PATH ?? "./data/feedback.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
log("info", "database.opened", { databasePath: dbPath, nodeVersion: process.version });
db.exec(`
  CREATE TABLE IF NOT EXISTS feedback_threads (
    thread_id TEXT PRIMARY KEY,
    guild_id TEXT NOT NULL,
    issue_number INTEGER,
    state TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    delivery_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
const getThread = db.prepare("SELECT * FROM feedback_threads WHERE thread_id = ?");
const addThread = db.prepare(
  "INSERT OR IGNORE INTO feedback_threads (thread_id, guild_id, state) VALUES (?, ?, 'pending')",
);
const getByIssue = db.prepare("SELECT * FROM feedback_threads WHERE issue_number = ?");
const setIssue = db.prepare(
  "UPDATE feedback_threads SET issue_number = ?, state = 'approved' WHERE thread_id = ? AND issue_number IS NULL",
);
const setState = db.prepare("UPDATE feedback_threads SET state = ? WHERE thread_id = ?");
const claimPending = db.prepare("UPDATE feedback_threads SET state = 'creating' WHERE thread_id = ? AND state = 'pending'");
const resetCreating = db.prepare("UPDATE feedback_threads SET state = 'pending' WHERE thread_id = ? AND state = 'creating'");
const seenDelivery = db.prepare("SELECT delivery_id FROM webhook_deliveries WHERE delivery_id = ?");
const saveDelivery = db.prepare("INSERT OR IGNORE INTO webhook_deliveries (delivery_id) VALUES (?)");

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
const approvalRow = (threadId: string) =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`feedback:approve:${threadId}`).setLabel("Approve & create issue").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`feedback:reject:${threadId}`).setLabel("Reject").setStyle(ButtonStyle.Danger),
  );

async function githubApi<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repoName}${endpoint}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    log("error", "github.api_failed", { endpoint, status: response.status, detail: detail.slice(0, 300) });
    throw new Error(`GitHub API ${response.status}: ${detail.slice(0, 500)}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function hasBridgeMarker(text: string): boolean {
  return text.includes("<!-- kitawatch-bridge:");
}
function safeTitle(text: string, fallback: string): string {
  const firstLine = text.split("\n").map((line) => line.trim()).find(Boolean) ?? fallback;
  return firstLine.replace(/^#+\s*/, "").slice(0, 250) || fallback;
}
async function applyTags(thread: ThreadChannel, tagIds: (string | undefined)[]) {
  const ids = tagIds.filter((id): id is string => Boolean(id));
  if (ids.length === 0) return;
  try {
    const existing = "appliedTags" in thread ? thread.appliedTags : [];
    const kept = existing.filter((id) => ![pendingTag, approvedTag, rejectedTag, resolvedTag].includes(id));
    await thread.setAppliedTags([...kept, ...ids].slice(0, 5));
  } catch (error) {
    log("error", "discord.tag_update_failed", { threadId: thread.id, error: errorMessage(error) });
  }
}
async function getThreadChannel(threadId: string): Promise<ThreadChannel | null> {
  try {
    const channel = await client.channels.fetch(threadId);
    return channel?.isThread() ? (channel as ThreadChannel) : null;
  } catch (error) {
    log("error", "discord.thread_fetch_failed", { threadId, error: errorMessage(error) });
    return null;
  }
}

const githubTypeLabelByForumTag = new Map<string, string>([
  ["bug", "bug"],
  ["enhancement", "enhancement"],
  ["feature request", "enhancement"],
  ["question", "question"],
]);
const githubStatusLabels = new Set(["status: triage", "status: in-progress", "status: resolved"]);

async function getGitHubTypeLabels(thread: ThreadChannel): Promise<string[]> {
  try {
    const forum = await client.channels.fetch(env.DISCORD_FORUM_CHANNEL_ID!);
    if (!forum || forum.type !== ChannelType.GuildForum) return [];

    const appliedTagIds = new Set(thread.appliedTags);
    const labels = forum.availableTags
      .filter((tag) => appliedTagIds.has(tag.id))
      .map((tag) => githubTypeLabelByForumTag.get(tag.name.trim().toLowerCase()))
      .filter((label): label is string => Boolean(label));
    return [...new Set(labels)];
  } catch (error) {
    log("warn", "github.issue_type_labels_unavailable", {
      threadId: thread.id,
      error: errorMessage(error),
    });
    return [];
  }
}

async function syncGitHubStatusLabel(
  issueNumber: number,
  statusLabel: "status: triage" | "status: resolved",
): Promise<void> {
  const issue = await githubApi<{ labels: Array<{ name: string }> }>("/issues/" + issueNumber);
  const labels = (issue.labels ?? [])
    .map((label) => label.name)
    .filter((name) => !githubStatusLabels.has(name.toLowerCase()));

  if (!labels.some((name) => name.toLowerCase() === statusLabel)) {
    labels.push(statusLabel);
  }

  await githubApi("/issues/" + issueNumber, {
    method: "PATCH",
    body: JSON.stringify({ labels }),
  });
  log("info", "github.issue_status_label_synced", { issueNumber, statusLabel });
}

client.once(Events.ClientReady, async (readyClient) => {
  log("info", "discord.ready", { tag: readyClient.user.tag, userId: readyClient.user.id, guildId: env.DISCORD_GUILD_ID, forumChannelId: env.DISCORD_FORUM_CHANNEL_ID });
  try {
    const guild = await readyClient.guilds.fetch(env.DISCORD_GUILD_ID!);
    const channel = await guild.channels.fetch(env.DISCORD_FORUM_CHANNEL_ID!);
    const isForum = channel?.type === 15;
    log(isForum ? "info" : "error", "discord.forum_check", { found: Boolean(channel), isForum, channelType: channel?.type ?? null, guildId: guild.id });
    if (!isForum) return;
    const permissions = channel.permissionsFor(readyClient.user);
    const requiredPermissions = ["ViewChannel", "ReadMessageHistory", "SendMessagesInThreads", "ManageThreads"] as const;
    const missingPermissions = requiredPermissions.filter((permission) => !permissions?.has(permission));
    log(missingPermissions.length ? "error" : "info", "discord.permission_check", { missingPermissions, requiredPermissions });
    if (moderatorRoles.size === 0) log("warn", "config.no_moderator_roles", { message: "No moderator role IDs configured; nobody can approve or reject submissions." });
  } catch (error) {
    log("error", "startup.discord_check_failed", { error: errorMessage(error) });
  }
});

client.on(Events.ThreadCreate, async (thread) => {
  if (thread.parentId !== env.DISCORD_FORUM_CHANNEL_ID || thread.guildId !== env.DISCORD_GUILD_ID) return;
  log("info", "discord.forum_post_created", { threadId: thread.id, guildId: thread.guildId });
  addThread.run(thread.id, thread.guildId);
  await applyTags(thread, [pendingTag]);
  try {
    const starter = await thread.fetchStarterMessage();
    if (!starter) {
      log("warn", "discord.starter_message_missing", { threadId: thread.id, hint: "Check View Channel, Read Message History, and Send Messages in Threads permissions." });
      return;
    }
    await starter.reply({
      content: "This submission is awaiting moderator review. Please keep discussion in this thread.",
      components: [approvalRow(thread.id)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    log("error", "discord.review_controls_failed", { threadId: thread.id, error: errorMessage(error) });
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;
  const match = /^feedback:(approve|reject):(\d+)$/.exec(interaction.customId);
  if (!match) return;
  if (!interaction.inGuild() || interaction.guildId !== env.DISCORD_GUILD_ID) {
    await interaction.reply({ content: "This action is not available here.", ephemeral: true });
    return;
  }
  let isModerator = false;
  try {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    isModerator = [...moderatorRoles].some((id) => member.roles.cache.has(id));
  } catch {
    isModerator = false;
  }
  if (!isModerator) {
    log("warn", "discord.moderator_check_denied", { userId: interaction.user.id, guildId: interaction.guildId });
    await interaction.reply({ content: "Only configured moderators can review submissions.", ephemeral: true });
    return;
  }

  const [, action, threadId] = match;
  const row = getThread.get(threadId) as { issue_number: number | null; state: string } | undefined;
  if (!row) {
    await interaction.reply({ content: "This submission is not registered by the bot.", ephemeral: true });
    return;
  }
  if (row.state !== "pending") {
    await interaction.reply({ content: row.issue_number ? `Already linked to issue #${row.issue_number}.` : `This submission is already ${row.state}.`, ephemeral: true });
    return;
  }

  log("info", "approval.requested", { action, threadId, moderatorId: interaction.user.id });
  await interaction.deferReply({ ephemeral: true });
  const thread = await getThreadChannel(threadId);
  if (!thread) {
    await interaction.editReply("The forum thread could not be found.");
    return;
  }

  const claimed = claimPending.run(threadId);
  if (claimed.changes === 0) {
    await interaction.editReply("Another moderator action has already started for this submission. Refresh the thread before trying again.");
    return;
  }

  if (action === "reject") {
    setState.run("rejected", threadId);
    await applyTags(thread, [rejectedTag]);
    try {
      const starter = await thread.fetchStarterMessage();
      if (starter) await starter.reply("A moderator reviewed this submission and declined to create a GitHub issue.");
    } catch { /* Thread may have been deleted or locked. */ }
    await interaction.editReply("Submission rejected.");
    return;
  }

  try {
    const starter = await thread.fetchStarterMessage();
    if (!starter) throw new Error("Could not fetch the original forum post.");
    const title = safeTitle(thread.name, "KitaWatch feedback");
    const body = [
      starter.content || "_No description provided._",
      "",
      "---",
      `Submitted in Discord by <@!${starter.author.id}>.`,
      `[Open the original Discord discussion](https://discord.com/channels/${thread.guildId}/${thread.id})`,
      "",
      "<!-- kitawatch-bridge:issue -->",
    ].join("\n");
    const typeLabels = await getGitHubTypeLabels(thread);
    const issueLabels = [...new Set([...typeLabels, "status: triage"])];
    const issue = await githubApi<{ number: number; html_url: string }>("/issues", {
      method: "POST",
      body: JSON.stringify({ title, body, labels: issueLabels }),
    });
    const changed = setIssue.run(issue.number, threadId);
    if (changed.changes === 0) throw new Error("This submission was linked by another action; check GitHub before retrying.");
    await applyTags(thread, [approvedTag]);
    await starter.reply({
      content: `Approved by <@!${interaction.user.id}> — GitHub issue created: ${issue.html_url}`,
      allowedMentions: { users: [interaction.user.id] },
    });
    log("info", "approval.issue_created", { threadId, issueNumber: issue.number, issueUrl: issue.html_url, moderatorId: interaction.user.id });
    await interaction.editReply(`Created [issue #${issue.number}](${issue.html_url}).`);
  } catch (error) {
    resetCreating.run(threadId);
    log("error", "approval.failed", { threadId, action, error: errorMessage(error) });
    await interaction.editReply("Could not complete approval. Check the bot logs and GitHub before retrying, because a network timeout can leave the remote result uncertain.");
  }
});

client.on(Events.MessageCreate, async (message: Message) => {
  if (message.author.bot || !message.guildId || message.guildId !== env.DISCORD_GUILD_ID) return;
  if (!message.channel.isThread() || message.channel.parentId !== env.DISCORD_FORUM_CHANNEL_ID) return;
  const row = getThread.get(message.channel.id) as { issue_number: number | null; state: string } | undefined;
  if (!row?.issue_number || row.state !== "approved") return;
  if (hasBridgeMarker(message.content)) return;
  const body = [
    `**Discord — ${message.author.username}**`,
    "",
    message.content || "_(No text content; attachments may not be mirrored.)_",
    "",
    `[View Discord message](https://discord.com/channels/${message.guildId}/${message.channel.id}/${message.id})`,
    "",
    "<!-- kitawatch-bridge:discord -->",
  ].join("\n");
  try {
    await githubApi(`/issues/${row.issue_number}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
    log("info", "comment.discord_to_github", { threadId: message.channel.id, issueNumber: row.issue_number, messageId: message.id });
  } catch (error) {
    log("error", "comment.discord_to_github_failed", { threadId: message.channel.id, issueNumber: row.issue_number, messageId: message.id, error: errorMessage(error) });
  }
});

const app = express();

// Keep the expensive diagnostics endpoint from being used as an unlimited
// public trigger for database writes and outbound Discord/GitHub requests.
// Do not trust forwarded IP headers unless proxy trust is explicitly configured.
const diagnosticsRateLimit = new Map<string, { windowStartedAt: number; count: number }>();
const DIAGNOSTICS_WINDOW_MS = 60_000;
const DIAGNOSTICS_MAX_REQUESTS = 10;
const diagnosticsRateLimiter: express.RequestHandler = (req, res, next) => {
  const now = Date.now();
  const key = req.ip || "unknown";
  let bucket = diagnosticsRateLimit.get(key);

  if (!bucket || now - bucket.windowStartedAt >= DIAGNOSTICS_WINDOW_MS) {
    bucket = { windowStartedAt: now, count: 0 };
    diagnosticsRateLimit.set(key, bucket);
  }

  // Prune expired entries so the map does not grow indefinitely.
  for (const [ip, entry] of diagnosticsRateLimit) {
    if (now - entry.windowStartedAt >= DIAGNOSTICS_WINDOW_MS) diagnosticsRateLimit.delete(ip);
  }

  if (bucket.count >= DIAGNOSTICS_MAX_REQUESTS) {
    const retryAfter = Math.max(1, Math.ceil((DIAGNOSTICS_WINDOW_MS - (now - bucket.windowStartedAt)) / 1000));
    res.set("Retry-After", String(retryAfter)).status(429).json({ error: "Too many diagnostics requests. Try again later." });
    return;
  }

  bucket.count += 1;
  next();
};

app.get("/health", (_req, res) => res.status(200).json({
  ok: true,
  discordReady: client.isReady(),
  uptimeSeconds: Math.round(process.uptime()),
}));

// Detailed diagnostics are disabled unless a secret is configured.
app.get("/diagnostics", diagnosticsRateLimiter, async (req, res) => {
  const diagnosticsToken = env.DIAGNOSTICS_TOKEN;
  if (!diagnosticsToken) return res.status(404).json({ error: "Not found" });
  const provided = req.header("authorization")?.replace(/^Bearer\\s+/i, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(diagnosticsToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: "Unauthorized" });

  const checks: Record<string, { ok: boolean; detail?: string }> = {};
  try {
    db.prepare("SELECT 1").get();
    const probe = path.join(path.dirname(dbPath), `.kitawatch-write-test-${process.pid}`);
    fs.writeFileSync(probe, "ok", { flag: "wx" });
    fs.unlinkSync(probe);
    checks.database = { ok: true, detail: "SQLite query and directory write succeeded" };
  } catch (error) {
    checks.database = { ok: false, detail: errorMessage(error) };
  }
  checks.discord = { ok: client.isReady(), detail: client.isReady() ? "Gateway connected" : "Gateway not ready" };
  try {
    const githubRepo = await githubApi<{ full_name: string; permissions?: { issues?: boolean; push?: boolean } }>("");
    checks.github = { ok: githubRepo.full_name.toLowerCase() === repo.toLowerCase(), detail: `Repository reachable: ${githubRepo.full_name}; permissions: ${JSON.stringify(githubRepo.permissions ?? {})}` };
  } catch (error) {
    checks.github = { ok: false, detail: errorMessage(error) };
  }
  try {
    const guild = await client.guilds.fetch(env.DISCORD_GUILD_ID!);
    const channel = await guild.channels.fetch(env.DISCORD_FORUM_CHANNEL_ID!);
    const permissions = channel?.permissionsFor(client.user!);
    const requiredPermissions = ["ViewChannel", "ReadMessageHistory", "SendMessagesInThreads", "ManageThreads"] as const;
    const missing = requiredPermissions.filter((permission) => !permissions?.has(permission));
    checks.discordForum = { ok: channel?.type === 15 && missing.length === 0, detail: `isForum=${channel?.type === 15}; missingPermissions=${missing.join(",") || "none"}` };
  } catch (error) {
    checks.discordForum = { ok: false, detail: errorMessage(error) };
  }
  const ok = Object.values(checks).every((check) => check.ok);
  log(ok ? "info" : "warn", "diagnostics.requested", { checks });
  res.status(ok ? 200 : 503).json({
    ok,
    startedAt,
    nodeVersion: process.version,
    platform: process.platform,
    configured: {
      discordToken: Boolean(env.DISCORD_TOKEN),
      discordGuildId: Boolean(env.DISCORD_GUILD_ID),
      discordForumChannelId: Boolean(env.DISCORD_FORUM_CHANNEL_ID),
      moderatorRoleCount: moderatorRoles.size,
      githubToken: Boolean(env.GITHUB_TOKEN),
      githubWebhookSecret: Boolean(env.GITHUB_WEBHOOK_SECRET),
      databasePathConfigured: Boolean(env.DATABASE_PATH),
    },
    checks,
  });
});
app.post("/webhooks/github", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  const signature = req.header("x-hub-signature-256");
  const deliveryId = req.header("x-github-delivery");
  const event = req.header("x-github-event");
  if (!signature || !deliveryId || !event || !Buffer.isBuffer(req.body)) {
    log("warn", "webhook.invalid_request", { hasSignature: Boolean(signature), hasDeliveryId: Boolean(deliveryId), event: event ?? null, bodyIsBuffer: Buffer.isBuffer(req.body) });
    res.status(400).send("Missing webhook headers or raw body");
    return;
  }
  const expected = `sha256=${crypto.createHmac("sha256", env.GITHUB_WEBHOOK_SECRET!).update(req.body).digest("hex")}`;
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    log("warn", "webhook.invalid_signature", { deliveryId, event });
    res.status(401).send("Invalid signature");
    return;
  }
  if (seenDelivery.get(deliveryId)) {
    log("info", "webhook.duplicate", { deliveryId, event });
    res.status(200).send("Duplicate delivery ignored");
    return;
  }
  let payload: any;
  try {
    payload = JSON.parse(req.body.toString("utf8"));
  } catch {
    res.status(400).send("Invalid JSON");
    return;
  }
  saveDelivery.run(deliveryId);
  log("info", "webhook.accepted", { deliveryId, event, action: payload.action ?? null, issueNumber: payload.issue?.number ?? null });
  res.status(202).send("Accepted");

  try {
    if (event === "issue_comment" && payload.action === "created") {
      const issueNumber = payload.issue?.number as number | undefined;
      const comment = payload.comment;
      if (!issueNumber || !comment?.body || hasBridgeMarker(comment.body)) return;
      const linked = getByIssue.get(issueNumber) as { thread_id: string; state: string } | undefined;
      if (!linked || linked.state !== "approved") return;
      const thread = await getThreadChannel(linked.thread_id);
      if (!thread) return;
      await thread.send({
        content: `**GitHub — ${comment.user?.login ?? "user"}**\n\n${String(comment.body).slice(0, 1800)}\n\n[View GitHub comment](${comment.html_url})\n<!-- kitawatch-bridge:github -->`,
        allowedMentions: { parse: [] },
      });
      log("info", "comment.github_to_discord", { issueNumber, threadId: linked.thread_id, commentId: comment.id });
    } else if (event === "issues" && ["closed", "reopened"].includes(payload.action)) {
      const issueNumber = payload.issue?.number as number | undefined;
      if (!issueNumber) return;
      const linked = getByIssue.get(issueNumber) as { thread_id: string; state: string } | undefined;
      if (!linked) return;
      const thread = await getThreadChannel(linked.thread_id);
      if (!thread) return;
      if (payload.action === "closed") {
        try {
          await syncGitHubStatusLabel(issueNumber, "status: resolved");
        } catch (error) {
          log("error", "github.issue_status_label_sync_failed", {
            issueNumber,
            statusLabel: "status: resolved",
            error: errorMessage(error),
          });
        }
        setState.run("closed", linked.thread_id);
        await applyTags(thread, [resolvedTag]);
        await thread.setArchived(true, "Linked GitHub issue was closed");
      } else {
        try {
          await syncGitHubStatusLabel(issueNumber, "status: triage");
        } catch (error) {
          log("error", "github.issue_status_label_sync_failed", {
            issueNumber,
            statusLabel: "status: triage",
            error: errorMessage(error),
          });
        }
        setState.run("approved", linked.thread_id);
        await thread.setArchived(false, "Linked GitHub issue was reopened");
        await applyTags(thread, [approvedTag]);
        await thread.send("The linked GitHub issue was reopened.");
      }
    }
  } catch (error) {
    log("error", "webhook.processing_failed", { deliveryId, event, action: payload.action ?? null, error: errorMessage(error) });
  }
});

const port = Number(env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => log("info", "http.listening", { port, healthPath: "/health", webhookPath: "/webhooks/github", diagnosticsEnabled: Boolean(env.DIAGNOSTICS_TOKEN) }));
client.on(Events.Error, (error) => log("error", "discord.client_error", { error: errorMessage(error) }));
process.on("unhandledRejection", (reason) => log("error", "process.unhandled_rejection", { error: errorMessage(reason) }));
process.on("uncaughtException", (error) => {
  log("error", "process.uncaught_exception", { error: errorMessage(error) });
  process.exitCode = 1;
});
log("info", "startup.begin", { nodeVersion: process.version, platform: process.platform, databasePath: dbPath, repository: repo });
try {
  await client.login(env.DISCORD_TOKEN);
} catch (error) {
  log("error", "startup.discord_login_failed", { error: errorMessage(error) });
  process.exitCode = 1;
  throw error;
}
