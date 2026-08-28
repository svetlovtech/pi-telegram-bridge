// ──────────────────────────────────────────────────────────────────────────
// pi-telegram-bridge — bidirectional TUI ↔ Telegram bridge for Pi.
//
// Capabilities:
//   • Notifications (text) and media (photo/file) → Telegram
//   • Read files/messages from the user's Inbox service
//   • Relay ask_user_question dialogs to Telegram (blocking) and resolve the
//     TUI dialog when the user answers in Telegram first.
//   • Relay permission asks to Telegram and resolve the TUI permission dialog.
//
// Bidirectional semantics ("whoever answers first"):
//   • If the user answers in Telegram → the TUI dialog is closed with that
//     answer (via the fork-resolve events).
//   • If the user answers in TUI first → the pending Telegram blocking ask is
//     aborted and a "user chose …" notification is sent to Telegram.
// ──────────────────────────────────────────────────────────────────────────
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendFileSync } from "node:fs";
import {
  askQuestion,
  CHAT_TIMEOUT_MS,
  claimInbox,
  getSessionResponse,
  getAvailabilityState,
  isConfigured,
  listInbox,
  onServiceFailure,
  onServiceSuccess,
  readInboxFile,
  sendFile,
  sendNotify,
  sendPhoto,
  sendRichMessage,
  serviceLikelyUp,
  stopQuestion,
  subscribeAvailability,
  probeService,
  type QuestionOption,
  type QPayload,
} from "./api.js";
import type { QuestionAnswer } from "./types-helpers.js";
import { agentPrefix, tagHeader } from "./identity.js";
import { formatInboxListing, fmtSize } from "./inbox.js";

// ── Shared event channel names (forks listen on these) ────────────────────
const ASK_RESOLVE_EVENT = "pi-telegram-bridge:resolve-ask";
const PERMISSION_RESOLVE_EVENT = "pi-telegram-bridge:resolve-permission";

// Pending Telegram asks per call, keyed by toolCallId / requestId. Each holds
// an AbortController so a TUI-first answer can cancel the blocking TG call.
const pendingAborts = new Map<string, AbortController>();
// Session ids of in-flight chat-service questions, so a TUI-first answer can
// ask the server to close (edit) the Telegram message via /question/stop.
const pendingSessionIds = new Map<string, string>();
const answeredInTui = new Set<string>();

// ── Inbox freshness (session watermark) ──────────────────────────────────
// The first tg_inbox_list of a session sets the baseline; later listings
// show only files that arrived after the previous listing (uploaded_at is
// the server clock, so this is immune to bridge↔server clock skew).
// Reset per session.
let inboxWatermark: number | null = null;
let sessionStartedAt = new Date();

/** Temporary file trace of the ask relay chain (remove once stable). */
function trace(msg: string): void {
  try {
    appendFileSync("/tmp/pi-tg-bridge.log", `${new Date().toISOString()} ${msg}\n`);
  } catch { /* ignore */ }
}

function trackAbort(key: string): { controller: AbortController; resolve: () => void } {
  const controller = new AbortController();
  const existing = pendingAborts.get(key);
  existing?.abort();
  pendingAborts.set(key, controller);
  return {
    controller,
    resolve: () => pendingAborts.delete(key),
  };
}

/** True when a session-response payload carries the final batch outcome. */
function isFinalSessionResponse(r: { status?: unknown }): boolean {
  return typeof r?.status === "string";
}

/**
 * Blocking ask with mid-flight disconnect recovery. Long-polling requests can
 * be silently dropped by middleboxes after ~15-20 minutes of silence; when
 * that happens the server-side sessions keep running, so instead of failing
 * we re-attach by polling GET /response/:session_id until an outcome shows up.
 */
async function askQuestionResilient(
  sessionId: string,
  questions: QPayload[],
  opts: { signal?: AbortSignal; timeoutMs?: number; trace?: (msg: string) => void } = {},
): Promise<QuestionResponse> {
  const timeoutMs = opts.timeoutMs ?? CHAT_TIMEOUT_MS;
  try {
    return await askQuestion(sessionId, questions, { signal: opts.signal, timeoutMs });
  } catch (error) {
    if (isAbortErrorLocal(error)) throw error;
    const note = error instanceof Error ? error.message : String(error);
    opts.trace?.(`transport lost (${note}) — re-attaching via response polling`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      try {
        const r = await getSessionResponse(sessionId);
        if (isFinalSessionResponse(r)) {
          return r as QuestionResponse;
        }
      } catch (pollError) {
        if (isAbortErrorLocal(pollError)) throw pollError;
        // transient poll failure — keep retrying until the deadline
      }
      await new Promise((r) => setTimeout(r, 3_000));
    }
    return { status: "timeout" };
  }
}

/** Local abort check (avoids import cycle with helpers below). */
function isAbortErrorLocal(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && (error as { name?: string }).name === "AbortError")
  );
}

export default function telegramBridge(pi: ExtensionAPI) {
  const configured = isConfigured();

  // ── Footer/status indicator for chat-service availability ─────────────
  // Shows 🔴/🟢 in pi's status line so it's visible when the Telegram
  // chat-service is unreachable (and the bridge is in fail-open mode).
  const STATUS_KEY = "tg-bridge";
  type CtxLike = { ui?: { setStatus?: (k: string, v: string | undefined) => void } };
  let currentCtx: CtxLike | undefined;

  const renderStatus = (state: string): string | undefined => {
    // Compact on purpose: the status row is shared with other extensions.
    if (state === "down") return "🔴 chat";
    if (state === "up") return "🟢 chat";
    return "⚪ chat";
  };

  const applyStatus = (state: "up" | "down" | "unknown"): void => {
    if (!currentCtx?.ui?.setStatus) return;
    const v = state === "unknown" ? undefined : renderStatus(state);
    try {
      currentCtx.ui.setStatus(STATUS_KEY, v);
    } catch {
      /* best-effort */
    }
  };

  // Capture ctx for setStatus; subscribe to availability transitions.
  pi.on("session_start", (_event: unknown, ctx: CtxLike) => {
    currentCtx = ctx as CtxLike;
    applyStatus(getAvailabilityState());
    // New session → fresh inbox baseline: the first listing of the session
    // shows everything (with ages), later ones only new arrivals.
    sessionStartedAt = new Date();
    inboxWatermark = null;
    // Probe so the status reflects reality without waiting for a tool call.
    if (configured) probeService();
  });
  subscribeAvailability((state) => applyStatus(state));

  // ── Tools ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "tg_notify",
    label: "Send Telegram Notification",
    description:
      "Send a plain-text notification to the user via Telegram. Non-blocking. " +
      "Use for progress updates, alerts, completion messages. " +
      "No Telegram Markdown escaping needed — plain text is fine, \\n for line breaks. " +
      "If not configured, this returns an explanatory message instead of failing.",
    parameters: Type.Object({
      message: Type.String({ description: "The notification text to send" }),
      blocks: Type.Optional(
        Type.Array(Type.Record(Type.String(), Type.Unknown()), {
          description:
            "Optional Telegram Rich Message blocks (Bot API 10.2) for styled output " +
            "(heading/paragraph/table/pre/etc). When provided, overrides the plain `message`. " +
            "Load the 'telegram-rich-messages' skill first. Table cells are a list of lists.",
        }),
      ),
    }),
    promptSnippet: "Send a Telegram notification to the user",
    async execute(
      _id: string,
      params: { message: string; blocks?: Record<string, unknown>[] },
    ): Promise<unknown> {
      if (!configured || !serviceLikelyUp()) {
        return notReady("notification", "tg_notify");
      }
      try {
        if (params.blocks && params.blocks.length > 0) {
          await sendRichMessage(params.blocks);
        } else {
          await sendNotify("✉️ " + agentPrefix(), params.message);
        }
        return reply("Notification sent to Telegram.");
      } catch (error) {
        onServiceFailure();
        return replyError(error, "tg_notify");
      }
    },
  });

  pi.registerTool({
    name: "tg_send_image",
    label: "Send Telegram Image",
    description:
      "Send an image file (PNG/JPEG/WebP) to the user's Telegram as an inline photo.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Absolute path to the image" }),
      caption: Type.Optional(Type.String({ description: "Optional caption" })),
    }),
    promptSnippet: "Send an image to the user's Telegram",
    async execute(
      _id: string,
      params: { file_path: string; caption?: string },
    ): Promise<unknown> {
      if (!configured) {
        return { content: [{ type: "text", text: "Telegram bridge not configured." }], details: {} };
      }
      try {
        await sendPhoto(params.file_path, params.caption);
        return { content: [{ type: "text", text: "Image sent to Telegram." }], details: {} };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "tg_send_file",
    label: "Send Telegram File",
    description:
      "Send any file (PDF, archive, source code, etc.) to the user's Telegram as a document attachment.",
    parameters: Type.Object({
      file_path: Type.String({ description: "Absolute path to the file" }),
      caption: Type.Optional(Type.String({ description: "Optional caption" })),
    }),
    promptSnippet: "Send a file to the user's Telegram",
    async execute(
      _id: string,
      params: { file_path: string; caption?: string },
    ): Promise<unknown> {
      if (!configured) {
        return { content: [{ type: "text", text: "Telegram bridge not configured." }], details: {} };
      }
      try {
        await sendFile(params.file_path, params.caption);
        return { content: [{ type: "text", text: "File sent to Telegram." }], details: {} };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "tg_send_rich",
    label: "Send Rich Telegram Message",
    description:
      "Send a structured Telegram Rich Message (Bot API 10.2) built from `blocks`. " +
      "Use for headings, tables, code blocks, lists, quotes, collages. " +
      "IMPORTANT: load the 'telegram-rich-messages' skill first — the #1 mistake is " +
      "that table.cells is a list of lists (each row wrapped in [ ]) and every cell " +
      "needs {text, align, valign}. collage/slideshow accept ONLY photo blocks.",
    parameters: Type.Object({
      blocks: Type.Array(Type.Record(Type.String(), Type.Unknown()), {
        description:
          "Rich Message blocks array. Every block needs a \"type\" (heading/paragraph/pre/table/list/blockquote/pullquote/details/divider/footer/collage/slideshow).",
      }),
    }),
    promptSnippet: "Send a structured Rich Telegram message (tables, headings, code, collages)",
    async execute(
      _id: string,
      params: { blocks: Record<string, unknown>[] },
    ): Promise<unknown> {
      if (!configured || !serviceLikelyUp()) {
        return notReady("rich message", "tg_send_rich");
      }
      try {
        await sendRichMessage(params.blocks);
        return reply("Rich message sent to Telegram.");
      } catch (error) {
        onServiceFailure();
        return replyError(error, "tg_send_rich");
      }
    },
  });

  pi.registerTool({
    name: "tg_inbox_list",
    label: "List Telegram Inbox",
    description:
      "List files and attachments the user sent to the agent's Telegram Inbox. " +
      "Files are newest-first with ages; anything older than the session start is stale — " +
      "ignore it unless the user asks. By default only files that arrived after your previous " +
      "listing in this session are shown; pass include_old=true to see the full inbox.",
    parameters: Type.Object({
      include_old: Type.Optional(
        Type.Boolean({
          description:
            "Show ALL files including older ones hidden by the session watermark " +
            "(default: only files newer than your last listing)",
        }),
      ),
    }),
    promptSnippet: "List files available in the Telegram Inbox (newest first, with ages)",
    async execute(
      _id: string,
      params: { include_old?: boolean },
    ): Promise<unknown> {
      if (!configured) {
        return { content: [{ type: "text", text: "Telegram bridge not configured." }], details: {} };
      }
      try {
        const inbox = await listInbox();
        const files = inbox.files ?? [];
        if (inbox.status === "empty" || files.length === 0) {
          inboxWatermark = Date.now();
          return { content: [{ type: "text", text: "Inbox is empty." }], details: inbox };
        }
        const out = formatInboxListing({
          files,
          now: new Date(),
          sessionStartedAt,
          includeOld: params.include_old === true,
          watermark: inboxWatermark,
        });
        inboxWatermark = out.nextWatermark;
        return { content: [{ type: "text", text: out.text }], details: { ...inbox, shown: out.shownCount, hidden: out.hiddenCount } };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "tg_inbox_read",
    label: "Read Telegram Inbox File",
    description:
      "Download a file from the Telegram Inbox by its file_id (from tg_inbox_list). " +
      "Saves to /tmp and returns the local path plus a text preview when the file is text. " +
      "Listings are newest-first with ages: anything older than the session start is stale — " +
      "ignore it unless the user asks.",
    parameters: Type.Object({
      file_id: Type.String({ description: "File id from tg_inbox_list" }),
    }),
    promptSnippet: "Download and read a file from the Telegram Inbox",
    async execute(_id: string, params: { file_id: string }): Promise<unknown> {
      if (!configured) {
        return { content: [{ type: "text", text: "Telegram bridge not configured." }], details: {} };
      }
      try {
        const f = await readInboxFile(params.file_id);
        const detail = `File saved: ${f.path}\n   Name: ${f.name}\n   Type: ${f.contentType}\n   Size: ${fmtSize(f.size)}`;
        const preview = f.text ? `\n\n--- Preview ---\n${f.text}\n...` : "";
        return { content: [{ type: "text", text: `${detail}${preview}` }], details: f };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: "tg_inbox_claim",
    label: "Clear Telegram Inbox",
    description:
      "Delete ALL files currently waiting in the Telegram Inbox (destructive). Returns how many were removed.",
    parameters: Type.Object({}),
    promptSnippet: "Clear all files from the Telegram Inbox",
    async execute(): Promise<unknown> {
      if (!configured) {
        return { content: [{ type: "text", text: "Telegram bridge not configured." }], details: {} };
      }
      try {
        const result = await claimInbox();
        return {
          content: [{ type: "text", text: `Inbox cleared: ${result.files_removed} file(s) removed.` }],
          details: result,
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }], details: {} };
      }
    },
  });

  if (!configured) return;

  // ── ask_user_question relay ────────────────────────────────────────────
  pi.events.on("rpiv:ask-user:prompt", (data: unknown) => {
    const p = payload(data) as { toolCallId?: string; questions?: unknown[] } | undefined;
    trace(`prompt received toolCallId=${p?.toolCallId ?? "?"} questions=${p?.questions?.length ?? 0}`);
    void relayAsk(payload(data));
  });

  async function relayAsk(p: {
    toolCallId?: string;
    questions: Array<{
      question: string;
      header: string;
      multiSelect: boolean;
      options: Array<{ label: string; description: string }>;
    }>;
  }) {
    if (!p || !p.questions?.length) return;
    // Skip if this ask was already answered in TUI (no pending work).
    if (answeredInTui.has(p.toolCallId ?? "")) return;
    // Fail open when chat-service is down: let the TUI dialog handle it.
    if (!serviceLikelyUp()) return;

    const sessionId = `pi-ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tgQuestions: QPayload[] = p.questions.map((q) => ({
      header: tagHeader(q.header),
      question: q.question,
      multiple: q.multiSelect,
      options: q.options.length > 0 ? q.options : [{ label: "OK", description: "Acknowledge" }],
    }));

    const key = p.toolCallId ?? "ask";
    pendingSessionIds.set(key, sessionId);
    const { controller, resolve } = trackAbort(key);
    try {
      const res = await askQuestionResilient(sessionId, tgQuestions, {
        signal: controller.signal,
        trace: (msg) => trace(`relayAsk key=${key}: ${msg}`),
      });
      // If this call was aborted because the user answered in TUI, ignore.
      if (controller.signal.aborted || answeredInTui.has(key)) {
        answeredInTui.delete(key);
        return;
      }
      // Map TG answers back to TUI answers (one per question).
      const answers: QuestionAnswer[] = p.questions.map((q, i) => ({
        questionIndex: i,
        question: q.question,
        kind: q.multiSelect ? "multi" : "option",
        answer: res.results?.[i]?.answer ?? res.answer,
        // multi-select: collect all result answers per index
        selected: q.multiSelect && res.results
          ? res.results.filter((r) => r.question_index === i && r.answer).map((r) => r.answer!)
          : undefined,
      }));
      // Resolve the TUI dialog with these answers.
      trace(`TG batch complete key=${key} emitting resolve-ask answers=${JSON.stringify(answers).slice(0, 300)}`);
      pi.events.emit(ASK_RESOLVE_EVENT, { toolCallId: key, answers });
      trace(`resolve-ask emitted key=${key}`);
    } catch (error) {
      // Expected: the blocking TG call was aborted because the user answered
      // in TUI first. Nothing to do — the TUI dialog already produced answers.
      if (isAbortError(error)) {
        trace(`relayAsk aborted key=${key}`);
        answeredInTui.delete(key);
        return;
      }
      trace(`relayAsk error key=${key}: ${error instanceof Error ? error.stack : String(error)}`);
      onServiceFailure();
    } finally {
      pendingSessionIds.delete(key);
      resolve();
    }
  }

  // Detect a TUI-first answer for ask_user_question: blocked:false ends the wait.
  pi.events.on("rpiv:ask-user:blocked", (data: unknown) => {
    const p = payload(data) as { active?: boolean; summary?: string; perQuestion?: string[] };
    if (p?.active === false) {
      // The TUI dialog ended (answered or cancelled). Abort any pending TG
      // ask and close it server-side: the server appends each question's own
      // answer INTO its original message (single-message UX, no separate
      // "Ответ из терминала" notification).
      for (const [key, controller] of pendingAborts) {
        answeredInTui.add(key);
        controller.abort();
        const sid = pendingSessionIds.get(key);
        if (sid) void stopQuestion(sid, p.summary, p.perQuestion).catch(() => {});
      }
      pendingAborts.clear();
      pendingSessionIds.clear();
    }
  });

  // Safety net: if the ask_user_question tool call finalizes WITHOUT the
  // blocked event having cleaned up (e.g. the dialog was declined/cancelled
  // through a path that never emits rpiv:ask-user:blocked), close the
  // pending Telegram batch here. Normal Telegram-first resolution removes
  // its pending entry before this fires, so it no-ops then.
  pi.on("tool_execution_end", async (event: unknown) => {
    const p = payload(event) as { toolCallId?: string; toolName?: string };
    if (!p?.toolCallId || p.toolName !== "ask_user_question") return;
    const key = p.toolCallId;
    const controller = pendingAborts.get(key);
    if (!controller) return; // already resolved / not ours
    answeredInTui.add(key);
    controller.abort();
    const sid = pendingSessionIds.get(key);
    if (sid) void stopQuestion(sid, "диалог закрыт в терминале").catch(() => {});
    pendingAborts.delete(key);
    pendingSessionIds.delete(key);
  });

  // ── permission relay ───────────────────────────────────────────────────
  pi.events.on("permissions:ui_prompt", (data: unknown) => {
    void relayPermission(payload(data));
  });

  async function relayPermission(p: {
    requestId?: string;
    surface?: string | null;
    value?: string | null;
    message?: string;
  }) {
    if (!p || !p.requestId) return;
    const key = p.requestId;
    if (answeredInTui.has(key)) return;
    // Fail open when chat-service is down: let the TUI permission dialog handle it.
    if (!serviceLikelyUp()) return;

    const qText = p.message ?? `${p.surface ?? "tool"}: ${p.value ?? ""}`;
    const sessionId = `pi-perm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pendingSessionIds.set(key, sessionId);
    const opts: QuestionOption[] = [
      { label: "Allow", description: "Approve this action" },
      { label: "Deny", description: "Block this action" },
    ];
    const { controller, resolve } = trackAbort(key);
    try {
      const res = await askQuestion(sessionId, [
        // kind:"permission" → ❗ «Запрос на выполнение» card on the server.
        { header: tagHeader("Permission Required"), kind: "permission", question: qText, options: opts },
      ], { signal: controller.signal });
      if (controller.signal.aborted || answeredInTui.has(key)) {
        answeredInTui.delete(key);
        return;
      }
      const decision = res.answer?.toLowerCase().includes("allow")
        ? { approved: true, state: "approved" as const }
        : { approved: false, state: "denied" as const };
      pi.events.emit(PERMISSION_RESOLVE_EVENT, { requestId: key, decision });
    } catch (error) {
      // Expected: aborted because the user answered in TUI first.
      if (isAbortError(error)) {
        answeredInTui.delete(key);
        return;
      }
      onServiceFailure();
    } finally {
      pendingSessionIds.delete(key);
      resolve();
    }
  }

  // Detect a TUI-first permission decision (permissions:decision) and mirror
  // it into the Telegram question message via stop-with-selection: the server
  // marks the chosen Allow/Deny option with a green checkmark and flips the
  // card title to “✅ … — разрешено” / “❌ … — отклонено” (same UX as answered
  // questions). The text verdict is passed as the note so older chat-servers
  // that ignore `selections` keep appending the readable trail.
  pi.events.on("permissions:decision", (data: unknown) => {
    const p = payload(data) as {
      requestId?: string;
      result?: string;
      resolution?: string;
      surface?: string | null;
      value?: string | null;
    };
    if (!p || !p.requestId) return;
    const key = p.requestId;
    if (p.resolution?.startsWith("user_") || p.resolution === "session_approved") {
      answeredInTui.add(key);
      pendingAborts.get(key)?.abort();
      pendingAborts.delete(key);
      const sid = pendingSessionIds.get(key);
      pendingSessionIds.delete(key);
      const what = p.surface && p.value ? `${p.surface}: ${p.value}` : p.surface ?? "request";
      const denied =
        p.result === "deny" ||
        (p.result == null && (p.resolution.includes("denied") || p.resolution === "user_deny"));
      const verdict = denied ? "❌ запрещено" : "✅ разрешено";
      // Permission card options are always [Allow(1), Deny(2)] above.
      if (sid) void stopQuestion(sid, `${verdict}: ${what}`, undefined, [[denied ? 2 : 1]]).catch(() => {});
    }
  });
}

// Loose payload accessor (the steered event emitter delivers unknown-shaped data).
function payload(data: unknown): Record<string, unknown> {
  return (data && typeof data === "object" ? data as Record<string, unknown> : {}) as Record<string, unknown>;
}

// ── Small result helpers (graceful degradation) ───────────────────────────

function reply(text: string): unknown {
  return { content: [{ type: "text" as const, text }], details: {} };
}

function replyError(error: unknown, tool: string): unknown {
  return {
    content: [{
      type: "text" as const,
      text: `${tool}: ${error instanceof Error ? error.message : String(error)}`,
    }],
    details: {},
  };
}

/** True for the AbortError thrown by an aborted fetch (planned, not a bug). */
function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    typeof error === "object" && error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

function notReady(action: string, tool: string): unknown {
  return {
    content: [{
      type: "text" as const,
      text:
        `Telegram chat-service currently unreachable — ${action} skipped (${tool}). ` +
        `The agent should continue without the Telegram notification; nothing was lost.`,
    }],
    details: {},
  };
}
