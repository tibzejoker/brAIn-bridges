import * as path from "node:path";
import * as fs from "node:fs";
import { Bot, GrammyError, HttpError } from "grammy";
import { BrainService, logger } from "@brain/core";
import type {
  NodeHandler,
  NodeInfo,
  NodeOnSpawn,
  NodeTeardown,
  TextPayload,
} from "@brain/sdk";

const PLATFORM = "telegram";

interface SeenChat {
  id: number;
  title: string;
  type: string;
  last_seen: number;
}

interface ConfigOverrides {
  /** Token from @BotFather. When empty/missing the bridge sits idle. */
  bot_token?: string;
  /** Optional whitelist of chat ids; when empty/missing every seen chat receives mirrors. */
  allowed_chat_ids?: number[];
}

interface ControlPayload {
  action?: "connect" | "disconnect" | "status";
}

let nodeId: string | null = null;
let bot: Bot | null = null;
let activeToken: string | null = null;
let seenChats = new Map<number, SeenChat>();
let chatStorePath: string | null = null;

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
    "bridge.telegram.status",
    { content: state },
    { state, platform: PLATFORM, ...extra },
    1,
  );
}

function publishChats(): void {
  const list = Array.from(seenChats.values()).sort((a, b) => b.last_seen - a.last_seen);
  publish(
    "bridge.telegram.chats",
    { content: JSON.stringify({ chats: list }) },
    { chats: list, platform: PLATFORM },
    1,
  );
}

function loadSeenChats(dir: string): void {
  chatStorePath = path.join(dir, "seen_chats.json");
  try {
    if (fs.existsSync(chatStorePath)) {
      const raw = JSON.parse(fs.readFileSync(chatStorePath, "utf8")) as SeenChat[];
      seenChats = new Map(raw.map((c) => [c.id, c]));
    }
  } catch (err) {
    logger.warn({ err, path: chatStorePath }, "telegram bridge: failed to load seen_chats.json");
  }
}

function saveSeenChats(): void {
  if (!chatStorePath) return;
  try {
    fs.writeFileSync(chatStorePath, JSON.stringify(Array.from(seenChats.values()), null, 2));
  } catch (err) {
    logger.warn({ err }, "telegram bridge: failed to write seen_chats.json");
  }
}

/**
 * Boot a new grammy bot for the given token, wire incoming-message →
 * chat.input. Replaces any existing bot. Returns true if the bot started.
 */
async function startBot(token: string): Promise<boolean> {
  await stopBot();
  if (!token || token.length < 20) {
    publishStatus("idle", { reason: "no-token" });
    return false;
  }
  const b = new Bot(token);
  bot = b;
  activeToken = token;

  b.on("message:text", (ctx) => {
    const chat = ctx.chat;
    const text = ctx.message.text;
    const from = ctx.from;
    const sender = from
      ? `${from.first_name ?? ""}${from.last_name ? " " + from.last_name : ""}`.trim() || from.username || `tg-${from.id}`
      : "unknown";

    // Remember the chat so future bus → telegram mirrors know where to fan out.
    // grammy's Chat is a discriminated union (group/private/channel/…); rather
    // than narrow through every branch, read the candidate fields dynamically.
    const known = seenChats.get(chat.id);
    const chatAny = chat as unknown as { title?: string; first_name?: string; last_name?: string };
    const fullName = [chatAny.first_name, chatAny.last_name].filter(Boolean).join(" ");
    const title = chatAny.title ?? fullName ?? `chat-${chat.id}`;
    seenChats.set(chat.id, {
      id: chat.id,
      title: title || (known?.title ?? `chat-${chat.id}`),
      type: chat.type,
      last_seen: Date.now(),
    });
    saveSeenChats();
    publishChats();

    // Push to the bus as a chat.input — same surface as the web chat node.
    publish(
      "chat.input",
      { content: text },
      {
        platform: PLATFORM,
        chat_id: chat.id,
        chat_type: chat.type,
        sender,
        sender_id: from?.id,
        message_id: ctx.message.message_id,
      },
      4,
    );
  });

  b.catch((err) => {
    if (err.error instanceof GrammyError) {
      logger.error({ err: err.error.description }, "telegram bridge: grammy error");
      publishStatus("error", { error: err.error.description });
    } else if (err.error instanceof HttpError) {
      logger.error({ err: err.error.message }, "telegram bridge: http error");
      publishStatus("error", { error: err.error.message });
    } else {
      logger.error({ err: err.error }, "telegram bridge: unknown error");
      publishStatus("error", { error: String(err.error) });
    }
  });

  // grammy's start() resolves only when the bot stops — fire-and-forget.
  publishStatus("connecting");
  void b.start({
    onStart: (me) => {
      logger.info({ username: me.username, id: me.id }, "telegram bridge: connected");
      publishStatus("connected", {
        bot_username: me.username,
        bot_id: me.id,
        bot_first_name: me.first_name,
      });
      publishChats();
    },
  }).catch((err: unknown) => {
    logger.error({ err }, "telegram bridge: start failed");
    publishStatus("error", { error: err instanceof Error ? err.message : String(err) });
    void stopBot();
  });

  return true;
}

async function stopBot(): Promise<void> {
  const b = bot;
  if (!b) return;
  bot = null;
  activeToken = null;
  try {
    await b.stop();
  } catch { /* best-effort */ }
  publishStatus("disconnected");
}

/** Pretty-print a bus message into the text we send on Telegram. */
export function formatForTelegram(content: string, meta: Record<string, unknown>, topic: string): string {
  const platform = meta.platform as string | undefined;
  const sender = (meta.sender as string | undefined) ?? (meta.from as string | undefined);
  const isBrainReply = topic.startsWith("chat.response");

  if (isBrainReply) {
    return content;
  }
  // chat.input from another platform (web, whatsapp, discord, …)
  const source = platform ? `[${platform}${sender ? ` · ${sender}` : ""}]` : (sender ? `[${sender}]` : "");
  return source ? `${source} ${content}` : content;
}

async function forwardToTelegram(text: string, allowed?: number[]): Promise<void> {
  const b = bot;
  if (!b) return;
  const ids = allowed && allowed.length > 0
    ? allowed.filter((id) => seenChats.has(id))
    : Array.from(seenChats.keys());
  if (ids.length === 0) return;
  await Promise.all(
    ids.map((id) =>
      b.api.sendMessage(id, text).catch((err: unknown) => {
        logger.warn({ err, chat_id: id }, "telegram bridge: sendMessage failed");
      }),
    ),
  );
}

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  nodeId = info.id;
  const overrides = (info.config_overrides ?? {}) as ConfigOverrides;
  publishStatus("idle");

  // dataDir is set on the ctx, not on NodeInfo. The first handler call
  // will lazy-init the chat store. Until then, in-memory only.
  if (overrides.bot_token) {
    await startBot(overrides.bot_token);
  }
};

let runtimeSubsAdded = false;

export const handler: NodeHandler = async (ctx) => {
  nodeId ??= ctx.node.id;
  if (!chatStorePath) loadSeenChats(ctx.dataDir);

  // Defensive runtime subscriptions — older spawns may have missed
  // bridge.telegram.control / exact chat.response from the config.json.
  // ctx.subscribe is idempotent at the bus level (it just adds another
  // subscription record), so we guard with a process-local flag.
  if (!runtimeSubsAdded) {
    runtimeSubsAdded = true;
    const existing = new Set(ctx.node.subscriptions.map((s) => s.topic));
    if (!existing.has("bridge.telegram.control")) {
      ctx.subscribe("bridge.telegram.control", {
        description: "UI control plane — {action: connect|disconnect|status}.",
      });
    }
    if (!existing.has("chat.response")) {
      ctx.subscribe("chat.response", {
        description: "Brain replies (exact-topic flavor used by the default seed).",
      });
    }
  }

  const overrides = (ctx.node.config_overrides ?? {}) as ConfigOverrides;

  // Honour a token change (UI saved a new value) — restart the bot if needed.
  const desired = overrides.bot_token?.trim() ?? "";
  if (desired && desired !== activeToken) {
    await startBot(desired);
  } else if (!desired && bot) {
    await stopBot();
  }

  for (const msg of ctx.messages) {
    if (msg.topic === "bridge.telegram.control") {
      const payload = msg.payload as TextPayload;
      let action: ControlPayload["action"] | undefined;
      try {
        const parsed = JSON.parse(payload.content) as ControlPayload;
        action = parsed.action;
      } catch { /* may be plain text */ }
      action ??= (msg.metadata as ControlPayload | undefined)?.action;
      if (action === "connect" && desired) {
        await startBot(desired);
      } else if (action === "disconnect") {
        await stopBot();
      } else if (action === "status") {
        publishStatus(bot ? "connected" : "idle");
        publishChats();
      }
      continue;
    }

    // Loop guard — don't echo a Telegram-origin message back to Telegram.
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    if (meta.platform === PLATFORM) continue;
    if (!bot) continue;

    const payload = msg.payload as TextPayload;
    if (!payload?.content) continue;

    const text = formatForTelegram(payload.content, meta, msg.topic);
    await forwardToTelegram(text, overrides.allowed_chat_ids);
  }
};

export const teardown: NodeTeardown = async () => {
  await stopBot();
};

export default handler;
