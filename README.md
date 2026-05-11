# brAIn-bridges

Bridge nodes that mirror the brAIn chat bus to external messengers. The goal is **one conversation, every surface**: a message you type in Telegram lands in the brAIn web chat, in Discord, in WhatsApp — and any reply from the brain (or another human) goes back to all of them.

| Node | Status | Lib | Registration |
|---|---|---|---|
| `telegram` | ✅ working | [grammy](https://grammy.dev) | bot token from [@BotFather](https://t.me/BotFather) |
| `whatsapp` | planned | Baileys | QR pairing (WhatsApp Web) |
| `discord` | planned | discord.js | bot token (Developer Portal) |

## Bus contract

Every bridge listens to and publishes the **same** topics as the `chat` node:

| Direction | Topic | Use |
|---|---|---|
| publish | `chat.input` | When a user sends a message on the external platform — surfaced on the bus with `metadata.platform` set so loops are skipped. |
| subscribe | `chat.input` | Mirror messages from other platforms (web chat, other bridges) into the external one. |
| subscribe | `chat.response.*` | Mirror brain replies into the external platform. |
| publish | `bridge.<name>.status` | Connection state, errors. |

The bridge ignores any `chat.input` whose `metadata.platform` equals its own name — that's its own message coming back via the bus.

## Per-bridge UI

Each node has `has_ui: true`. The UI is a one-page setup checklist with copy-buttons for every token/URL the user needs to fetch, plus a live status pill.
