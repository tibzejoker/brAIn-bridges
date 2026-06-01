---
name: cross-channel-reply
description: Understand how the chat bridges (Telegram, Discord, WhatsApp) mirror one conversation, so you reply correctly. Use whenever a message arrives from a bridge or you're about to answer a bridged user.
---

# The chat bridges mirror one conversation

Telegram, Discord and WhatsApp are bridges onto the SAME conversation, and the mirroring is automatic at the bus level — you don't orchestrate it.

## What happens on its own
- A message typed on one bridge is published as `chat.input`. Every OTHER bridge receives it and forwards it to its platform (mirror), tagged `[platform · sender]`. The origin bridge does NOT re-receive its own message (the bus anti-loop blocks self-echo).
- So all three channels stay in sync without anyone managing it.

## What that means for you (the brain)
1. **Reply once on `chat.response`.** Every bridge is subscribed, so your single reply reaches all channels — Telegram, Discord and WhatsApp at once. Don't send one message per platform.
2. Treat the bridged channels as ONE conversation, not three separate threads.
3. Inbound lines prefixed `[platform · sender]` tell you who/where it came from — useful context, but you still answer once.

## Pitfalls
- Don't try to manually relay or fan-out to individual bridges — that double-sends. The bus already mirrors.
- Don't worry about echoing back to the origin: the anti-loop handles it. Your job is just one good reply on `chat.response`.
- Keep it plain text; bridges render limited markdown.
