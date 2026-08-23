# pi-telegram-bridge — own extension (no upstream)

Bidirectional TUI ↔ Telegram bridge for Pi: notifications, inbox reads,
`ask_user_question` relay, and permission relay through the user's Chat-Service.

- Loaded by Pi: `~/.pi/agent/settings.json` → `/home/dev/pi-forks/pi-telegram-bridge`
- GitHub repo (origin): https://github.com/svetlovtech/pi-telegram-bridge (private). Push: `git push origin master`.
- This is OUR project — there is no upstream to sync. It depends on two local forks:
  - `../rpiv-ask-user-question` — listens for `rpiv:ask-user:prompt` (with `toolCallId`) and emits `pi-telegram-bridge:resolve-ask`.
  - `../pi-permission-system` — listens for `permissions:ui_prompt` and emits `pi-telegram-bridge:resolve-permission` (wired via the `externalResolve` hook in that fork).
- Event channels (shared contract):
  - `rpiv:ask-user:prompt` / `rpiv:ask-user:blocked` (emitted by rpiv-ask-user-question)
  - `permissions:ui_prompt` / `permissions:decision` (emitted by pi-permission-system)
  - `pi-telegram-bridge:resolve-ask` / `pi-telegram-bridge:resolve-permission` (consumed by those forks)
- Service contract: Chat-Service (`POST /question`, blocking; see `src/api.ts`).

Build check:

```bash
bun build src/index.ts --target=bun --outdir=/tmp/tgout
```
