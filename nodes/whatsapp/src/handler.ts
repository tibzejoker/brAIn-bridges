import * as path from "node:path";
import * as fs from "node:fs";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WASocket,
  type ConnectionState,
  type WAMessage,
  type AuthenticationState,
} from "@whiskeysockets/baileys";
import { toDataURL as qrToDataURL } from "qrcode";
import { BrainService, logger } from "@brain/core";
import type {
  NodeHandler,
  NodeInfo,
  NodeOnSpawn,
  NodeTeardown,
  TextPayload,
} from "@brain/sdk";

const PLATFORM = "whatsapp";

interface SeenChat {
  jid: string;
  title: string;
  type: "private" | "group" | "broadcast" | "status" | "unknown";
  last_seen: number;
}

interface ConfigOverrides {
  /** Whitelist of jids; empty = fan out to every chat the bridge has seen. */
  allowed_jids?: string[];
}

interface ControlPayload {
  action?: "connect" | "disconnect" | "logout" | "status";
}

let nodeId: string | null = null;
let sock: WASocket | null = null;
let saveCreds: (() => Promise<void>) | null = null;
let authState: AuthenticationState | null = null;
let authDir: string | null = null;
let seenChats = new Map<string, SeenChat>();
let chatStorePath: string | null = null;
let currentQrDataUrl: string | null = null;
let currentMe: { id: string; name?: string } | null = null;
let runtimeSubsAdded = false;
let starting = false;
let logoutRequested = false;
/**
 * Live WhatsApp Web protocol version. WA bumps it on the server side
 * regularly; using a stale one results in a `405 connection errored`
 * loop with no QR ever issued. Refreshed at most once per process.
 */
let waVersion: [number, number, number] | null = null;
/**
 * IDs of messages we sent via `sock.sendMessage` recently. WhatsApp echoes
 * them back as fromMe:true upserts on every linked device (including this
 * Baileys connection). Without a dedup we'd republish our own forwards on
 * chat.input and loop forever. TTL: 10 minutes, more than enough.
 */
const recentSentIds = new Map<string, number>();
const SENT_TTL_MS = 10 * 60_000;
function rememberSentId(id: string): void {
  recentSentIds.set(id, Date.now());
  // Opportunistic GC — keeps the map bounded without a setInterval.
  if (recentSentIds.size > 1000) {
    const cutoff = Date.now() - SENT_TTL_MS;
    for (const [k, v] of recentSentIds) if (v < cutoff) recentSentIds.delete(k);
  }
}
function wasSentByUs(id: string | null | undefined): boolean {
  if (!id) return false;
  const t = recentSentIds.get(id);
  if (t === undefined) return false;
  if (Date.now() - t > SENT_TTL_MS) {
    recentSentIds.delete(id);
    return false;
  }
  return true;
}

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
    "bridge.whatsapp.status",
    { content: state },
    { state, platform: PLATFORM, ...extra },
    1,
  );
}

function publishQr(dataUrl: string | null): void {
  publish(
    "bridge.whatsapp.qr",
    { content: dataUrl ?? "" },
    { qr: dataUrl, platform: PLATFORM },
    1,
  );
}

function publishChats(): void {
  const list = Array.from(seenChats.values()).sort((a, b) => b.last_seen - a.last_seen);
  publish(
    "bridge.whatsapp.chats",
    { content: JSON.stringify({ chats: list }) },
    { chats: list, platform: PLATFORM },
    1,
  );
}

function loadSeenChats(dataDir: string): void {
  chatStorePath = path.join(dataDir, "seen_chats.json");
  try {
    if (fs.existsSync(chatStorePath)) {
      const raw = JSON.parse(fs.readFileSync(chatStorePath, "utf8")) as SeenChat[];
      seenChats = new Map(raw.map((c) => [c.jid, c]));
    }
  } catch (err) {
    logger.warn({ err, path: chatStorePath }, "whatsapp bridge: failed to load seen_chats.json");
  }
}

function saveSeenChats(): void {
  if (!chatStorePath) return;
  try {
    fs.writeFileSync(chatStorePath, JSON.stringify(Array.from(seenChats.values()), null, 2));
  } catch (err) {
    logger.warn({ err }, "whatsapp bridge: failed to write seen_chats.json");
  }
}

/** WhatsApp JIDs encode the chat kind in the suffix. */
export function jidType(jid: string): SeenChat["type"] {
  if (jid.endsWith("@s.whatsapp.net")) return "private";
  if (jid.endsWith("@g.us")) return "group";
  if (jid.endsWith("@broadcast")) return "broadcast";
  if (jid.endsWith("@status")) return "status";
  return "unknown";
}

/** Pull text out of the various WhatsApp message shapes. */
export function extractText(msg: WAMessage["message"]): string | null {
  if (!msg) return null;
  if (msg.conversation) return msg.conversation;
  if (msg.extendedTextMessage?.text) return msg.extendedTextMessage.text;
  if (msg.imageMessage?.caption) return msg.imageMessage.caption;
  if (msg.videoMessage?.caption) return msg.videoMessage.caption;
  return null;
}

/** Pretty-print a bus message for the WhatsApp side. */
export function formatForWhatsapp(content: string, meta: Record<string, unknown>, topic: string): string {
  const platform = meta.platform as string | undefined;
  const sender = (meta.sender as string | undefined) ?? (meta.from as string | undefined);
  if (topic.startsWith("chat.response")) return content;
  const source = platform ? `[${platform}${sender ? ` · ${sender}` : ""}]` : (sender ? `[${sender}]` : "");
  return source ? `${source} ${content}` : content;
}

async function ensureAuth(dataDir: string): Promise<void> {
  authDir = path.join(dataDir, "auth");
  fs.mkdirSync(authDir, { recursive: true });
  const { state, saveCreds: save } = await useMultiFileAuthState(authDir);
  authState = state;
  saveCreds = save;
}

async function startSock(): Promise<void> {
  if (starting) return;
  if (!authState) {
    logger.warn("whatsapp bridge: startSock called before auth was initialised");
    return;
  }
  starting = true;
  try {
    publishStatus("connecting");
    if (!waVersion) {
      try {
        const { version } = await fetchLatestBaileysVersion();
        waVersion = version;
        logger.info({ version }, "whatsapp bridge: using WA Web version");
      } catch (err) {
        logger.warn({ err }, "whatsapp bridge: fetchLatestBaileysVersion failed — falling back to bundled default");
      }
    }
    const s = makeWASocket({
      auth: authState,
      version: waVersion ?? undefined,
      printQRInTerminal: false,
      browser: ["brAIn", "Chrome", "1.0"],
      logger: logger.child({ scope: "baileys" }) as never,
    });
    sock = s;

    s.ev.on("creds.update", async () => {
      try { await saveCreds?.(); } catch (err) { logger.warn({ err }, "whatsapp: saveCreds failed"); }
    });

    s.ev.on("connection.update", (update: Partial<ConnectionState>) => {
      void handleConnectionUpdate(update);
    });

    s.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        // Loop guard: a fromMe:true upsert whose id we just emitted is
        // WhatsApp echoing our own sendMessage — skip. Anything else
        // fromMe was typed by the user on another linked device (phone),
        // which is exactly the "talk to yourself" UX OpenClaw exposes.
        if (m.key.fromMe && wasSentByUs(m.key.id ?? undefined)) continue;
        const jid = m.key.remoteJid;
        if (!jid) continue;
        const text = extractText(m.message ?? null);
        if (!text) continue;
        const senderName = m.key.fromMe
          ? "me"
          : (m.pushName ?? jid.split("@")[0] ?? "unknown");
        rememberChat(jid, m.key.fromMe ? (currentMe?.name ?? "me") : senderName);
        publish(
          "chat.input",
          { content: text },
          {
            platform: PLATFORM,
            chat_id: jid,
            chat_type: jidType(jid),
            sender: senderName,
            sender_jid: m.key.participant ?? m.key.fromMe ? (currentMe?.id ?? jid) : jid,
            message_id: m.key.id,
            from_me: m.key.fromMe,
          },
          4,
        );
      }
    });
  } finally {
    starting = false;
  }
}

function rememberChat(jid: string, fallbackTitle: string): void {
  const existing = seenChats.get(jid);
  seenChats.set(jid, {
    jid,
    title: existing?.title || fallbackTitle,
    type: jidType(jid),
    last_seen: Date.now(),
  });
  saveSeenChats();
  publishChats();
}

async function handleConnectionUpdate(update: Partial<ConnectionState>): Promise<void> {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    try {
      currentQrDataUrl = await qrToDataURL(qr, { width: 320, margin: 1 });
      publishQr(currentQrDataUrl);
      publishStatus("awaiting_scan", { has_qr: true });
    } catch (err) {
      logger.warn({ err }, "whatsapp: qr rendering failed");
    }
  }

  if (connection === "open") {
    currentQrDataUrl = null;
    publishQr(null);
    const me = sock?.user;
    if (me) {
      currentMe = { id: me.id, name: me.name };
      publishStatus("connected", { jid: me.id, name: me.name, phone: me.id.split(":")[0] });
    } else {
      publishStatus("connected");
    }
    publishChats();
    return;
  }

  if (connection === "close") {
    currentQrDataUrl = null;
    publishQr(null);
    // lastDisconnect.error is a @hapi/boom Error in practice — read the
    // status code dynamically so we don't have to depend on @hapi/boom directly.
    const err = lastDisconnect?.error as { output?: { statusCode?: number } } | undefined;
    const code = err?.output?.statusCode;
    const loggedOut = code === DisconnectReason.loggedOut || logoutRequested;
    if (loggedOut) {
      logoutRequested = false;
      currentMe = null;
      await wipeAuth();
      publishStatus("logged_out", { reason: lastDisconnect?.error?.message ?? "logged out" });
      return;
    }
    logger.info({ code }, "whatsapp bridge: connection closed, reconnecting");
    publishStatus("disconnected", { code, reason: lastDisconnect?.error?.message });
    // Reconnect after a short delay so we don't tight-loop on persistent errors.
    setTimeout(() => { void startSock(); }, 2000);
  }
}

async function stopSock({ logout = false }: { logout?: boolean } = {}): Promise<void> {
  const s = sock;
  if (!s) return;
  sock = null;
  try {
    if (logout) {
      logoutRequested = true;
      await s.logout();
    } else {
      s.end(undefined);
    }
  } catch (err) {
    logger.warn({ err }, "whatsapp bridge: stopSock error");
  }
}

async function wipeAuth(): Promise<void> {
  if (!authDir) return;
  try {
    fs.rmSync(authDir, { recursive: true, force: true });
    fs.mkdirSync(authDir, { recursive: true });
    // Re-initialise so the next connect produces a fresh QR.
    const { state, saveCreds: save } = await useMultiFileAuthState(authDir);
    authState = state;
    saveCreds = save;
  } catch (err) {
    logger.warn({ err }, "whatsapp bridge: wipeAuth failed");
  }
}

async function forwardToWhatsapp(text: string, allowed?: string[]): Promise<void> {
  const s = sock;
  if (!s) return;
  const jids = allowed && allowed.length > 0
    ? allowed.filter((j) => seenChats.has(j))
    : Array.from(seenChats.keys()).filter((j) => jidType(j) !== "status");
  if (jids.length === 0) return;
  await Promise.all(
    jids.map((jid) =>
      s.sendMessage(jid, { text })
        .then((res) => { if (res?.key?.id) rememberSentId(res.key.id); })
        .catch((err: unknown) => {
          logger.warn({ err, jid }, "whatsapp bridge: sendMessage failed");
        }),
    ),
  );
}

export const onSpawn: NodeOnSpawn = async (info: NodeInfo) => {
  nodeId = info.id;
  publishStatus("idle");
  // dataDir isn't on NodeInfo — the handler does the heavy init (ensureAuth,
  // resume from creds.json if any). Nudge it so we don't sit at "idle"
  // forever when the API reboots and no bus message arrives to wake us.
  setTimeout(() => {
    const b = bus();
    if (!b || !nodeId) return;
    b.publish({
      from: "system.whatsapp-boot",
      topic: "bridge.whatsapp.control",
      type: "text",
      criticality: 2,
      payload: { content: JSON.stringify({ action: "status" }) },
      metadata: { action: "status" },
    });
  }, 500);
};

export const handler: NodeHandler = async (ctx) => {
  nodeId ??= ctx.node.id;

  if (!chatStorePath) loadSeenChats(ctx.dataDir);
  if (!authState) {
    await ensureAuth(ctx.dataDir);
    // Auto-resume: if creds exist on disk (the user paired before), start
    // the socket; if not, sit idle until the UI says "connect".
    const credsFile = path.join(authDir as string, "creds.json");
    if (fs.existsSync(credsFile)) {
      void startSock();
    } else {
      publishStatus("idle", { reason: "not-paired" });
    }
  }

  if (!runtimeSubsAdded) {
    runtimeSubsAdded = true;
    const existing = new Set(ctx.node.subscriptions.map((s) => s.topic));
    for (const t of ["bridge.whatsapp.control", "chat.response"]) {
      if (!existing.has(t)) ctx.subscribe(t, { description: `runtime-added: ${t}` });
    }
  }

  const overrides = (ctx.node.config_overrides ?? {}) as ConfigOverrides;

  for (const msg of ctx.messages) {
    if (msg.topic === "bridge.whatsapp.control") {
      const payload = msg.payload as TextPayload;
      let action: ControlPayload["action"] | undefined;
      try {
        action = (JSON.parse(payload.content) as ControlPayload).action;
      } catch { /* fallthrough */ }
      action ??= (msg.metadata as ControlPayload | undefined)?.action;

      if (action === "connect") {
        if (!sock) void startSock();
        else {
          publishStatus("connected", currentMe ? { jid: currentMe.id, name: currentMe.name } : {});
          if (currentQrDataUrl) publishQr(currentQrDataUrl);
          publishChats();
        }
      } else if (action === "disconnect") {
        await stopSock();
        publishStatus("disconnected");
      } else if (action === "logout") {
        await stopSock({ logout: true });
      } else if (action === "status") {
        publishStatus(sock ? "connected" : "idle",
          currentMe ? { jid: currentMe.id, name: currentMe.name } : {});
        if (currentQrDataUrl) publishQr(currentQrDataUrl);
        publishChats();
      }
      continue;
    }

    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    if (meta.platform === PLATFORM) continue;
    if (!sock) continue;

    const payload = msg.payload as TextPayload;
    if (!payload?.content) continue;

    const text = formatForWhatsapp(payload.content, meta, msg.topic);
    await forwardToWhatsapp(text, overrides.allowed_jids);
  }
};

export const teardown: NodeTeardown = async () => {
  await stopSock();
};

export default handler;
