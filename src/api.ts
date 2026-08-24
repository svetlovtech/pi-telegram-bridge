import { mkdirSync, writeFileSync } from "node:fs";

// ──────────────────────────────────────────────────────────────────────────
// pi-telegram-bridge — config + Chat-Service API client
//
// Talks to the user's own Chat-Service (the same one the OpenCode telegram
// plugin uses) over REST. All outbound content is plain Rich-Message text —
// no escaping needed. Blocking question calls support an AbortSignal so a
// TUI-first answer can cancel the Telegram wait.
// ──────────────────────────────────────────────────────────────────────────

const SERVICE_URL = process.env.OPENCODE_CHAT_SERVICE_URL;
const SERVICE_TOKEN = process.env.OPENCODE_CHAT_SERVICE_TOKEN;
const TIMEOUT_MS =
  parseInt(process.env.OPENCODE_CHAT_SERVICE_TIMEOUT || "3600", 10) * 1000;

const API_PREFIX = "/api/chat-service";
export const ENDPOINTS = {
  notify: `${API_PREFIX}/notify`,
  sendRichMessage: `${API_PREFIX}/send-rich-message`,
  sendPhoto: `${API_PREFIX}/send-photo`,
  sendFile: `${API_PREFIX}/send-file`,
  question: `${API_PREFIX}/question`,
  questionStop: `${API_PREFIX}/question/stop`,
  inbox: `${API_PREFIX}/inbox`,
  inboxFile: (id: string) => `${API_PREFIX}/inbox/files/${id}`,
  inboxClaim: `${API_PREFIX}/inbox/claim`,
} as const;

export const ERROR_NOT_CONFIGURED =
  "Telegram bridge is not configured: OPENCODE_CHAT_SERVICE_URL and OPENCODE_CHAT_SERVICE_TOKEN must be set.";

export interface BridgeConfig {
  url: string;
  token: string;
}

export function requireConfig(): BridgeConfig {
  if (!SERVICE_URL || !SERVICE_TOKEN) {
    throw new Error(ERROR_NOT_CONFIGURED);
  }
  return { url: SERVICE_URL, token: SERVICE_TOKEN };
}

export function isConfigured(): boolean {
  return Boolean(SERVICE_URL && SERVICE_TOKEN);
}

export interface ApiOptions {
  method?: string;
  json?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const { url, token } = requireConfig();
  const {
    method = "GET",
    json,
    timeoutMs = 30_000,
    signal,
  } = opts;

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (method !== "GET" && json !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const controls = [AbortSignal.timeout(timeoutMs)];
  if (signal) controls.push(signal);
  const combined = AbortSignal.any(controls);

  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
      signal: combined,
    });
  } catch (error) {
    // A planned abort (user answered in TUI before Telegram) is not a
    // service-down condition — do not mark the service unhealthy.
    if (!(error instanceof DOMException && error.name === "AbortError")) {
      onServiceFailure();
    }
    throw error;
  }

  // Only a successful (2xx) response means chat-service is truly serving our
  // endpoints from this URL. A 404/5xx means the routes don't exist (e.g. the
  // URL points at the wrong host/proxy), so we must NOT report "online" —
  // otherwise the footer shows green while delivery keeps failing. Treat any
  // non-2xx as a failure so the availability state (and footer indicator)
  // stays honest.
  if (!response.ok) {
    onServiceFailure();
    const bodyText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${path}: ${bodyText}`);
  }
  onServiceSuccess();
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

// ── Service availability (graceful degradation when chat-service is down) ──

/**
 * Coarse availability cache so a down chat-service doesn't cause a flood of
 * connection errors on every tool call / event. A failed request records
 * "down" and suppresses repeats for a cooldown window; the first success
 * after that flips back to "up" and reports recovery.
 */
const availability = {
  state: "unknown" as "unknown" | "up" | "down",
  downAt: 0,
  notifiedDown: false,
  notifiedRecovery: false,
};

const DOWN_COOLDOWN_MS = 30_000;
type AvailabilityListener = (state: "up" | "down" | "unknown") => void;
const listeners = new Set<AvailabilityListener>();

/** Subscribe to availability transitions (fires on change and on subscribe). */
export function subscribeAvailability(cb: AvailabilityListener): () => void {
  listeners.add(cb);
  try {
    cb(availability.state);
  } catch { /* ignore */ }
  return () => listeners.delete(cb);
}

function notifyListeners(): void {
  for (const cb of listeners) {
    try {
      cb(availability.state);
    } catch { /* ignore */ }
  }
}

/** Whether the caller should bother trying given the last known state. */
export function serviceLikelyUp(): boolean {
  if (availability.state !== "down") return true;
  return Date.now() - availability.downAt > DOWN_COOLDOWN_MS;
}

/** Notify the bridge layer about an observed failure (for log/notify once). */
export function onServiceFailure(): void {
  availability.state = "down";
  availability.downAt = Date.now();
  if (!availability.notifiedDown) {
    availability.notifiedDown = true;
    availability.notifiedRecovery = false;
  }
  notifyListeners();
}

/** Notify the bridge layer about an observed success (report recovery once). */
export function onServiceSuccess(): void {
  const wasDown = availability.state === "down";
  availability.state = "up";
  if (wasDown && !availability.notifiedRecovery) {
    availability.notifiedRecovery = true;
    availability.notifiedDown = false;
  }
  notifyListeners();
}

/** Current availability state (for the footer indicator). */
export function getAvailabilityState(): "up" | "down" | "unknown" {
  return availability.state;
}

// ── Typed payloads ─────────────────────────────────────────────────────────

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionResponse {
  status: string;
  answer?: string;
  results?: Array<{
    question_index: number;
    status: string;
    answer?: string;
  }>;
}

export interface InboxFile {
  file_id: string;
  name: string;
  mime_type: string;
  size: number;
  uploaded_at: string;
}

export interface InboxInfo {
  status: string;
  inbox_id: string;
  files_count: number;
  files: InboxFile[];
  created_at: string | null;
  expires_at: string | null;
}

export interface InboxClaimResponse {
  status: string;
  files_removed: number;
  claimed_at: string | null;
  message?: string;
}

// ── Domain helpers ─────────────────────────────────────────────────────────

export interface QPayload {
  header: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
  blocks?: Record<string, unknown>[];
}

export function sendNotify(title: string, body: string): Promise<{ status: string }> {
  return request<{ status: string }>(ENDPOINTS.notify, {
    method: "POST",
    json: { title, body },
  });
}

export function sendRichMessage(
  blocks: Record<string, unknown>[],
): Promise<{ status: string; message_id?: number }> {
  return request<{ status: string; message_id?: number }>(ENDPOINTS.sendRichMessage, {
    method: "POST",
    json: { blocks },
  });
}

export function sendPhoto(
  filePath: string,
  caption?: string,
): Promise<{ status: string }> {
  return uploadAttachment(ENDPOINTS.sendPhoto, filePath, caption);
}

export function sendFile(
  filePath: string,
  caption?: string,
): Promise<{ status: string }> {
  return uploadAttachment(ENDPOINTS.sendFile, filePath, caption);
}

/**
 * Attachments travel as multipart/form-data uploads (the Go backend reads the
 * raw file from the "file" field; no server-local path access).
 */
async function uploadAttachment(
  path: string,
  filePath: string,
  caption?: string,
): Promise<{ status: string }> {
  const { url, token } = requireConfig();
  let form: FormData;
  try {
    const { readFileSync } = await import("node:fs");
    const { basename } = await import("node:path");
    const buffer = readFileSync(filePath);
    form = new FormData();
    form.append("file", new Blob([buffer]), basename(filePath));
    if (caption) form.append("caption", caption);
  } catch (error) {
    throw new Error(
      `cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let response: Response;
  try {
    response = await fetch(`${url}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    onServiceFailure();
    throw error;
  }
  if (!response.ok) {
    onServiceFailure();
    const bodyText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} from ${path}: ${bodyText}`);
  }
  onServiceSuccess();
  return { status: "sent" };
}

/**
 * Blocking question: sends options to Telegram and waits for the answer.
 * Pass an AbortSignal so a TUI-first answer can cancel this wait.
 */
export function askQuestion(
  sessionId: string,
  questions: QPayload[],
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<QuestionResponse> {
  return request<QuestionResponse>(ENDPOINTS.question, {
    method: "POST",
    json: { session_id: sessionId, questions },
    timeoutMs: opts.timeoutMs ?? TIMEOUT_MS,
    signal: opts.signal,
  });
}

/**
 * Best-effort cancel of a pending question session on the server (the server
 * then edits the Telegram message to "stopped" and removes the buttons).
 * Used when the user answered the same question in the TUI first.
 */
export function stopQuestion(
  sessionId: string,
): Promise<{ status: string; stopped: boolean }> {
  return request<{ status: string; stopped: boolean }>(ENDPOINTS.questionStop, {
    method: "POST",
    json: { session_id: sessionId },
    timeoutMs: 10_000,
  });
}

export function listInbox(): Promise<InboxInfo> {
  return request<InboxInfo>(ENDPOINTS.inbox, { timeoutMs: 30_000 });
}

/**
 * Non-blocking availability probe: a quick GET to the inbox endpoint updates
 * the availability state without throwing. Used at startup so the footer
 * indicator reflects reality before the first real tool call.
 */
export function probeService(): void {
  if (!isConfigured()) return;
  // Short timeout so a dead service resolves a status quickly.
  request<unknown>(ENDPOINTS.inbox, { timeoutMs: 6000 })
    .catch(() => {
      // failure already recorded by request()→onServiceFailure()
    });
}

export async function readInboxFile(fileId: string): Promise<{
  path: string;
  name: string;
  contentType: string;
  size: number;
  text?: string;
}> {
  const { url, token } = requireConfig();
  const response = await fetch(`${url}${ENDPOINTS.inboxFile(fileId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    onServiceFailure();
    const bodyText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} reading inbox file: ${bodyText}`);
  }
  onServiceSuccess();
  const contentType =
    response.headers.get("content-type") || "application/octet-stream";
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^"]+)"?/);
  const originalName = match ? match[1] : "file";
  const buffer = Buffer.from(await response.arrayBuffer());
  const localPath = `/tmp/inbox_${fileId.substring(0, 8)}_${originalName}`;
  mkdirSync("/tmp", { recursive: true });
  writeFileSync(localPath, buffer);
  const result = {
    path: localPath,
    name: originalName,
    contentType,
    size: buffer.length,
  };
  if (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml")
  ) {
    result.text = buffer.toString("utf-8").slice(0, 2000);
  }
  return result;
}

export function claimInbox(): Promise<InboxClaimResponse> {
  return request<InboxClaimResponse>(ENDPOINTS.inboxClaim, {
    method: "POST",
    timeoutMs: 30_000,
  });
}
