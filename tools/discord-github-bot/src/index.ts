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
    console.error("Could not update forum tags:", error);
  }
}
async function getThreadChannel(threadId: string): Promise<ThreadChannel | null> {
  try {
    const channel = await client.channels.fetch(threadId);
    return channel?.isThread() ? (channel as ThreadChannel) : null;
  } catch {
    return null;
  }
}

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Discord bot ready as ${readyClient.user.tag}`);
});

client.on(Events.ThreadCreate, async (thread) => {
  if (thread.parentId !== env.DISCORD_FORUM_CHANNEL_ID || thread.guildId !== env.DISCORD_GUILD_ID) return;
  addThread.run(thread.id, thread.guildId);
  await applyTags(thread, [pendingTag]);
  try {
    const starter = await thread.fetchStarterMessage();
    if (!starter) return;
    await starter.reply({
      content: "This submission is awaiting moderator review. Please keep discussion in this thread.",
      components: [approvalRow(thread.id)],
      allowedMentions: { parse: [] },
    });
  } catch (error) {
    console.error("Could not add review controls to forum post:", error);
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
    const title = safeTitle(starter.content, thread.name);
    const body = [
      starter.content || "_No description provided._",
      "",
      "---",
      `Submitted in Discord by <@!${starter.author.id}>.`,
      `[Open the original Discord discussion](https://discord.com/channels/${thread.guildId}/${thread.id})`,
      "",
      "<!-- kitawatch-bridge:issue -->",
    ].join("\n");
    const issue = await githubApi<{ number: number; html_url: string }>("/issues", {
      method: "POST",
      body: JSON.stringify({ title, body }),
    });
    const changed = setIssue.run(issue.number, threadId);
    if (changed.changes === 0) throw new Error("This submission was linked by another action; check GitHub before retrying.");
    await applyTags(thread, [approvedTag]);
    await starter.reply({
      content: `Approved by <@!${interaction.user.id}> — GitHub issue created: ${issue.html_url}`,
      allowedMentions: { users: [interaction.user.id] },
    });
    await interaction.editReply(`Created [issue #${issue.number}](${issue.html_url}).`);
  } catch (error) {
    resetCreating.run(threadId);
    console.error("Approval failed:", error);
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
  } catch (error) {
    console.error("Could not mirror Discord comment:", error);
  }
});

const app = express();
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
app.post("/webhooks/github", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
  const signature = req.header("x-hub-signature-256");
  const deliveryId = req.header("x-github-delivery");
  const event = req.header("x-github-event");
  if (!signature || !deliveryId || !event || !Buffer.isBuffer(req.body)) {
    res.status(400).send("Missing webhook headers or raw body");
    return;
  }
  const expected = `sha256=${crypto.createHmac("sha256", env.GITHUB_WEBHOOK_SECRET!).update(req.body).digest("hex")}`;
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(providedBuffer, expectedBuffer)) {
    res.status(401).send("Invalid signature");
    return;
  }
  if (seenDelivery.get(deliveryId)) {
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
    } else if (event === "issues" && ["closed", "reopened"].includes(payload.action)) {
      const issueNumber = payload.issue?.number as number | undefined;
      if (!issueNumber) return;
      const linked = getByIssue.get(issueNumber) as { thread_id: string; state: string } | undefined;
      if (!linked) return;
      const thread = await getThreadChannel(linked.thread_id);
      if (!thread) return;
      if (payload.action === "closed") {
        setState.run("closed", linked.thread_id);
        await applyTags(thread, [resolvedTag]);
        await thread.setArchived(true, "Linked GitHub issue was closed");
      } else {
        setState.run("approved", linked.thread_id);
        await thread.setArchived(false, "Linked GitHub issue was reopened");
        await applyTags(thread, [approvedTag]);
        await thread.send("The linked GitHub issue was reopened.");
      }
    }
  } catch (error) {
    console.error("Webhook processing failed:", error);
  }
});

const port = Number(env.PORT ?? 3000);
app.listen(port, "0.0.0.0", () => console.log(`Webhook server listening on port ${port}`));
await client.login(env.DISCORD_TOKEN);
