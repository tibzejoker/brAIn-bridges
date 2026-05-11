import * as path from "node:path";
import * as fs from "node:fs";
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Channel,
  type Message,
  type SendableChannels,
} from "discord.js";
import { BrainService, logger } from "@brain/core";
import type {
  NodeHandler,
  NodeInfo,
  NodeOnSpawn,
  NodeTeardown,
  TextPayload,
} from "@brain/sdk";

const PLATFORM = "discord";

interface SeenChannel {
  id: string;
  name: string;
  type: "dm" | "guild" | "thread" | "unknown";
  guild_name?: string;
  last_seen: number;
}

interface ConfigOverrides {
  bot_token?: string;
  /** Optional whitelist of channel ids — empty = every channel the bot has seen. */
  allowed_channel_ids?: string[];
}

interface ControlPayload {
  action?: "connect" | "disconnect" | "logout" | "status";
}

let nodeId: string | null = null;
let client: Client | null = null;
let activeToken: string | null = null;
let me: { id: string; tag: string } | null = null;
let seenChannels = new Map<string, SeenChannel>();
let channelStorePath: string | null = null;
let runtimeSubsAdded = false;
let starting = false;
let sharedTokenPath: string | null = null;

function bus(): NonNullable<typeof BrainService.current>["bus"] | null {
  return BrainService.current?.bus ?? null;
}

function publish(
  topic: string,
  payload: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  criticality = 3,
): void {
  const b = bus();
  if (!b || !nodeId) return;
  b.publish({
    from: nodeId,
    topic,
    type: "text",
    criticality,
    payload: { content: typeof payload.content === "string" ? payload.content : JSON.stringify(payload) },
    metadata: metadata ?? payload,
  });
}

function publishStatus(state: string, extra: Record<string, unknown> = {}): void {
  publish(
    "bridge.discord.status",
    { content: state },
    { state, platform: PLATFORM, ...extra },
    1,
  );
}

function publishChannels(): void {
  const list = Array.from(seenChannels.values()).sort((a, b) => b.last_seen - a.last_seen);
  publish(
    "bridge.discord.channels",
    { content: JSON.stringify({ channels: list }) },
    { channels: list, platform: PLATFORM },
    1,
  );
}

/**
 * Token store path shared by every discord bridge instance, keyed by
 * type — not by node id. So killing the node + spawning a fresh one
 * keeps the token (config_overrides on the new id is empty, but disk
 * still has the last paste). `<data-root>/bridges/discord/token.txt`.
 *
 * dataDir = <data-root>/nodes/<id>/ → step up twice to reach <data-root>.
 */
function setSharedTokenPath(dataDir: string): void {
  const rootData = path.dirname(path.dirname(dataDir));
  sharedTokenPath = path.join(rootData, "bridges", "discord", "token.txt");
}

function loadSavedToken(): string | null {
  try {
    if (sharedTokenPath && fs.existsSync(sharedTokenPath)) {
      return fs.readFileSync(sharedTokenPath, "utf8").trim() || null;
    }
  } catch (err) {
    logger.warn({ err, path: sharedTokenPath }, "discord bridge: loadSavedToken failed");
  }
  return null;
}

function saveTokenToDisk(token: string): void {
  if (!sharedTokenPath) return;
  try {
    fs.mkdirSync(path.dirname(sharedTokenPath), { recursive: true });
    fs.writeFileSync(sharedTokenPath, token, { mode: 0o600 });
  } catch (err) {
    logger.warn({ err, path: sharedTokenPath }, "discord bridge: saveTokenToDisk failed");
  }
}

function wipeTokenFromDisk(): void {
  if (!sharedTokenPath) return;
  try { if (fs.existsSync(sharedTokenPath)) fs.unlinkSync(sharedTokenPath); }
  catch (err) { logger.warn({ err }, "discord bridge: wipeTokenFromDisk failed"); }
}

function loadSeenChannels(dataDir: string): void {
  channelStorePath = path.join(dataDir, "seen_channels.json");
  try {
    if (fs.existsSync(channelStorePath)) {
      const raw = JSON.parse(fs.readFileSync(channelStorePath, "utf8")) as SeenChannel[];
      seenChannels = new Map(raw.map((c) => [c.id, c]));
    }
  } catch (err) {
    logger.warn({ err, path: channelStorePath }, "discord bridge: failed to load seen_channels.json");
  }
}

function saveSeenChannels(): void {
  if (!channelStorePath) return;
  try {
    fs.writeFileSync(channelStorePath, JSON.stringify(Array.from(seenChannels.values()), null, 2));
  } catch (err) {
    logger.warn({ err }, "discord bridge: failed to write seen_channels.json");
  }
}

export function channelKind(c: Channel | null | undefined): SeenChannel["type"] {
  if (!c) return "unknown";
  if (c.isDMBased()) return "dm";
  if (c.isThread?.()) return "thread";
  if ("guild" in c && c.guild) return "guild";
  return "unknown";
}

export function channelLabel(c: Channel | null | undefined): { name: string; guildName?: string } {
  if (!c) return { name: "unknown" };
  if (c.isDMBased()) {
    const recipient = "recipient" in c ? (c as { recipient?: { username?: string; tag?: string } }).recipient : undefined;
    const name = recipient?.username ?? recipient?.tag ?? "DM";
    return { name: `DM · ${name}` };
  }
  const named = c as { name?: string; guild?: { name?: string } };
  return { name: named.name ?? c.id, guildName: named.guild?.name };
}

/** Pretty-print a bus message for the Discord side. */
export function formatForDiscord(content: string, meta: Record<string, unknown>, topic: string): string {
  const platform = meta.platform as string | undefined;
  const sender = (meta.sender as string | undefined) ?? (meta.from as string | undefined);
  if (topic.startsWith("chat.response")) return content;
  const source = platform ? `[${platform}${sender ? ` · ${sender}` : ""}]` : (sender ? `[${sender}]` : "");
  return source ? `${source} ${content}` : content;
}

async function startClient(token: string): Promise<boolean> {
  if (starting) return false;
  await stopClient();
  if (!token || token.length < 20) {
    publishStatus("idle", { reason: "no-token" });
    return false;
  }
  starting = true;
  publishStatus("connecting");
  try {
    const c = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // DMs only fire MessageCreate reliably if we partialise Channel/Message
      // (Discord delivers them via a different cache path).
      partials: [Partials.Channel, Partials.Message],
    });
    client = c;
    activeToken = token;

    c.once(Events.ClientReady, (ready) => {
      me = { id: ready.user.id, tag: ready.user.tag };
      logger.info({ tag: ready.user.tag }, "discord bridge: connected");
      publishStatus("connected", {
        bot_id: ready.user.id,
        bot_tag: ready.user.tag,
        bot_username: ready.user.username,
        guilds: ready.guilds.cache.map((g) => ({ id: g.id, name: g.name })),
      });
      publishChannels();
    });

    c.on(Events.MessageCreate, (m: Message) => {
      void onIncomingMessage(m);
    });

    c.on(Events.Error, (err) => {
      logger.warn({ err }, "discord bridge: client error");
      publishStatus("error", { error: err.message });
    });

    await c.login(token);
    return true;
  } catch (err) {
    logger.error({ err }, "discord bridge: login failed");
    publishStatus("error", { error: err instanceof Error ? err.message : String(err) });
    await stopClient();
    return false;
  } finally {
    starting = false;
  }
}

/**
 * Strips Discord's `<@id>` / `<@!id>` mention tokens from a raw message
 * body — both the bot's own and anyone else's — so the brain doesn't
 * read "@brainBot hello" out loud as part of the question.
 */
export function stripMentions(text: string, botId: string | undefined): string {
  let out = text;
  if (botId) {
    out = out.replace(new RegExp(`<@!?${botId}>`, "g"), "");
  }
  // Generic dangling mentions left over from other users — replace with
  // their resolved nickname is too much work for v1, just drop the token.
  out = out.replace(/<@!?\d+>/g, "");
  return out.replace(/\s+/g, " ").trim();
}

async function onIncomingMessage(m: Message): Promise<void> {
  // Loop prevention layer 1: never echo our own messages.
  if (m.author.bot && m.author.id === me?.id) return;
  // Loop prevention layer 2: skip other bots by default to keep brAIn out
  // of bot-to-bot crossfire — flip to opt-in via config later if needed.
  if (m.author.bot) return;

  const text = m.content?.trim();
  if (!text) return;

  // In a guild channel the bot stays quiet unless it's explicitly
  // addressed — same convention as every well-behaved Discord bot:
  //   - @mention of the bot anywhere in the message, OR
  //   - a reply (m.reference) pointing at one of the bot's own messages.
  // In DMs we always react.
  const isDm = !m.guildId;
  if (!isDm) {
    const mentioned = me ? m.mentions.users.has(me.id) : false;
    const isReplyToBot = await (async () => {
      const ref = m.reference;
      if (!ref?.messageId || !me) return false;
      try {
        const refMsg = await m.channel.messages.fetch(ref.messageId);
        return refMsg.author.id === me.id;
      } catch { return false; }
    })();
    if (!mentioned && !isReplyToBot) return;
  }

  const cleanText = stripMentions(text, me?.id);
  if (!cleanText) return;

  const kind = channelKind(m.channel);
  const { name, guildName } = channelLabel(m.channel);
  seenChannels.set(m.channelId, {
    id: m.channelId,
    name,
    type: kind,
    guild_name: guildName,
    last_seen: Date.now(),
  });
  saveSeenChannels();
  publishChannels();

  publish(
    "chat.input",
    { content: cleanText },
    {
      platform: PLATFORM,
      chat_id: m.channelId,
      chat_type: kind,
      guild_id: m.guildId ?? null,
      guild_name: guildName ?? null,
      sender: m.author.username,
      sender_id: m.author.id,
      message_id: m.id,
      addressed_via: isDm ? "dm" : "mention_or_reply",
    },
    4,
  );
}

async function stopClient(): Promise<void> {
  const c = client;
  if (!c) return;
  client = null;
  activeToken = null;
  me = null;
  try { await c.destroy(); } catch { /* best-effort */ }
  publishStatus("disconnected");
}

async function forwardToDiscord(text: string, allowed?: string[]): Promise<void> {
  const c = client;
  if (!c) return;
  const ids = allowed && allowed.length > 0
    ? allowed.filter((id) => seenChannels.has(id))
    : Array.from(seenChannels.keys());
  if (ids.length === 0) return;

  await Promise.all(ids.map(async (id) => {
    try {
      // Always fetch — a cached channel from a Partials.Channel boot can
      // be a partial DM object without `.send`. Fetching forces a full
      // hydration and works for guild text channels too.
      const channel = await c.channels.fetch(id);
      if (!channel || !channel.isTextBased()) return;
      await (channel as unknown as SendableChannels).send(text);
    } catch (err) {
      logger.warn({ err, channel_id: id }, "discord bridge: send failed");
      publishStatus("send_error", { channel_id: id, error: err instanceof Error ? err.message : String(err) });
    }
  }));
}

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  nodeId = info.id;
  const overrides = (info.config_overrides ?? {}) as ConfigOverrides;
  publishStatus("idle");

  // Fast path: token already in config_overrides (restored from SQLite
  // after an API restart). Connect immediately.
  if (overrides.bot_token) {
    void startClient(overrides.bot_token);
    return;
  }

  // Slow path: kill+respawn drops config_overrides, but the per-type disk
  // cache (data/bridges/discord/token.txt) may still hold a token.
  // Trigger the handler so it runs the disk fallback without us having
  // to wait for a real bus message.
  setTimeout(() => {
    const b = bus();
    if (!b || !nodeId) return;
    b.publish({
      from: "system.discord-boot",
      topic: "bridge.discord.control",
      type: "text",
      criticality: 2,
      payload: { content: JSON.stringify({ action: "status" }) },
      metadata: { action: "status" },
    });
  }, 500);
};

export const handler: NodeHandler = async (ctx) => {
  nodeId ??= ctx.node.id;
  if (!channelStorePath) loadSeenChannels(ctx.dataDir);
  if (!sharedTokenPath) setSharedTokenPath(ctx.dataDir);

  if (!runtimeSubsAdded) {
    runtimeSubsAdded = true;
    const existing = new Set(ctx.node.subscriptions.map((s) => s.topic));
    for (const t of ["bridge.discord.control", "chat.response"]) {
      if (!existing.has(t)) ctx.subscribe(t, { description: `runtime-added: ${t}` });
    }
  }

  const overrides = (ctx.node.config_overrides ?? {}) as ConfigOverrides;

  // Token resolution: config_overrides wins (UI just pasted) → else fall
  // back to the per-type disk cache, so killing+respawning the node keeps
  // the bot online without re-pasting.
  let desired = overrides.bot_token?.trim() ?? "";
  if (!desired) {
    const saved = loadSavedToken();
    if (saved) desired = saved;
  } else if (desired !== loadSavedToken()) {
    saveTokenToDisk(desired);
  }

  if (desired && desired !== activeToken) {
    void startClient(desired);
  } else if (!desired && client) {
    await stopClient();
  }

  for (const msg of ctx.messages) {
    if (msg.topic === "bridge.discord.control") {
      const payload = msg.payload as TextPayload;
      let action: ControlPayload["action"] | undefined;
      try {
        action = (JSON.parse(payload.content) as ControlPayload).action;
      } catch { /* fallthrough */ }
      action ??= (msg.metadata as ControlPayload | undefined)?.action;

      if (action === "connect" && desired) {
        if (!client || activeToken !== desired) void startClient(desired);
      } else if (action === "disconnect") {
        await stopClient();
      } else if (action === "logout") {
        await stopClient();
        wipeTokenFromDisk();
        publishStatus("idle", { reason: "no-token" });
      } else if (action === "status") {
        publishStatus(client ? "connected" : "idle", me ? { bot_id: me.id, bot_tag: me.tag } : {});
        publishChannels();
      }
      continue;
    }

    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    if (meta.platform === PLATFORM) continue;
    if (!client) continue;

    const payload = msg.payload as TextPayload;
    if (!payload?.content) continue;

    const text = formatForDiscord(payload.content, meta, msg.topic);
    await forwardToDiscord(text, overrides.allowed_channel_ids);
  }
};

export const teardown: NodeTeardown = async () => {
  await stopClient();
};

export default handler;
