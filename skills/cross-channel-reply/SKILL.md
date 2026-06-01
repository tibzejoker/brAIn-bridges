---
name: cross-channel-reply
description: Reply to a user on the chat app they came from (Telegram, Discord, WhatsApp). Use whenever an incoming message arrived through a bridge and your answer must go back to that same person and channel.
---

# Replying across a bridge

A message that came in through a bridge carries where it's from. Your reply has to go back there, not to the generic chat.

## Steps
1. Read the incoming message's origin metadata (which bridge, which chat/user id).
2. Send your reply back through the SAME bridge, addressed to that chat/user id — don't broadcast.
3. Keep formatting plain; bridges render limited markdown.

## Pitfalls
- Don't leak one channel's conversation into another (a Telegram reply must not land in Discord).
- If the origin id is missing, ask the bridge rather than guessing a destination.
- One reply per user turn; bridges rate-limit and double-sends read as spam.
