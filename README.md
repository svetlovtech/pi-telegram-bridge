# pi-telegram-bridge

Bidirectional TUI ↔ Telegram bridge for Pi: notifications, inbox reads,
`ask_user_question` relay, and permission relay through a compatible
chat-service backend.

> **Note:** this extension is not a standalone Telegram bot. It requires a
> compatible chat-service backend that exposes the `/api/chat-service/*`
> endpoints (Bearer auth) and relays messages to Telegram.

See [AGENTS.md](AGENTS.md) for the full architecture overview.

## Usage

Install into your pi extensions directory and add it to
`~/.pi/agent/settings.json`. Set the environment variables below so the
bridge can reach your chat-service, then the `tg_*` tools become available
to the agent.

### Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENCODE_CHAT_SERVICE_URL` | yes | — | Base URL of the chat-service backend |
| `OPENCODE_CHAT_SERVICE_TOKEN` | yes | — | Bearer token for the chat-service API |
| `OPENCODE_CHAT_SERVICE_TIMEOUT` | no | `3600` | Blocking-question lifetime, seconds |

Without URL and token the extension loads but reports that it is not
configured.

### Tools

- `tg_notify` — send a text notification to the owner's Telegram.
- `tg_send_image` — send a photo (by path or URL).
- `tg_send_file` — send a file (by path).
- `tg_send_rich` — send a rich message (markdown).
- `tg_inbox_list` — list inbox files (newest first, freshness-aware).
- `tg_inbox_read` — read an inbox file into the conversation.
- `tg_inbox_claim` — mark an inbox file as claimed.

### Event contracts

Bidirectional dialogs follow "whoever answers first": a Telegram answer
closes the TUI dialog, and a TUI answer aborts/closes the pending Telegram
question.

Inbound (emitted by companion extensions, consumed here):

- `rpiv:ask-user:prompt` — `{toolCallId, questions}` starts an ask_user_question relay.
- `rpiv:ask-user:blocked` — `{active: false, summary, perQuestion}` signals the TUI dialog ended first.
- `permissions:ui_prompt` — `{requestId, surface, value, message}` starts a permission relay.
- `permissions:decision` — the TUI permission dialog was resolved first.

Outbound (emitted here, consumed by companion extensions):

- `pi-telegram-bridge:resolve-ask` — `{toolCallId, answers}` resolves the TUI ask dialog.
- `pi-telegram-bridge:resolve-permission` — resolves the TUI permission dialog.

## Build check

```bash
bun build src/index.ts --target=bun --outdir=/tmp/tgout
```
