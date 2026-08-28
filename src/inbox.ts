// ──────────────────────────────────────────────────────────────────────────
// Inbox listing formatter: ages, newest-first ordering, age buckets and a
// per-session watermark so stale files stop resurfacing in every listing.
//
// Pure functions — no I/O — so the bridge tool just stores `nextWatermark`.
// ──────────────────────────────────────────────────────────────────────────

export interface InboxFileLike {
  file_id: string;
  name: string;
  mime_type?: string;
  size: number;
  uploaded_at?: string;
}

export interface ListingInput {
  /** Files as returned by the chat-service (any order). */
  files: InboxFileLike[];
  now: Date;
  /** When the current pi session started (for the stale verdict). */
  sessionStartedAt: Date;
  /** include_old=true — show everything, ignoring the watermark. */
  includeOld: boolean;
  /** Session watermark (ms epoch) of the last listing; null = first call. */
  watermark: number | null;
}

export interface ListingOutput {
  text: string;
  shownCount: number;
  hiddenCount: number;
  /** Store this as the new session watermark after the call. */
  nextWatermark: number;
}

/** Human-readable size (single source — index.ts imports this). */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** Russian plural: fmtPlural(2, ["день","дня","дней"]) → "дня". */
function fmtPlural(n: number, forms: [string, string, string]): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

/** Human age in Russian: "только что", "5 мин назад", "3 часа назад", "2 дня назад". */
export function fmtAge(ms: number): string {
  if (ms < 45_000) return "только что";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} ${fmtPlural(hours, ["час", "часа", "часов"])} назад`;
  const days = Math.round(ms / 86_400_000);
  return `${days} ${fmtPlural(days, ["день", "дня", "дней"])} назад`;
}

/** Absolute timestamp "2026-08-25 18:14 UTC" for unambiguous reference. */
export function fmtUtc(d: Date): string {
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

interface Dated {
  file: InboxFileLike;
  ts: number; // ms epoch, 0 when unknown
}

/**
 * Formats the tg_inbox_list output:
 *   • newest-first, each line with human age + absolute UTC time;
 *   • header with `now` and session start;
 *   • age buckets with a stale verdict;
 *   • session watermark: by default only files newer than the last listing
 *     are shown, everything else is summarised in a "hidden" note.
 */
export function formatInboxListing(input: ListingInput): ListingOutput {
  const { now, sessionStartedAt, includeOld, watermark } = input;

  const dated: Dated[] = input.files.map((file) => {
    const ts = file.uploaded_at ? Date.parse(file.uploaded_at) : NaN;
    return { file, ts: Number.isFinite(ts) ? ts : 0 };
  });
  // Newest first; unknown timestamps sink to the bottom.
  dated.sort((a, b) => b.ts - a.ts);

  const visible = includeOld || watermark === null
    ? dated
    : dated.filter((d) => d.ts > (watermark as number));
  const hiddenCount = dated.length - visible.length;

  const maxShownTs = visible.length > 0 ? Math.max(...visible.map((d) => d.ts)) : 0;
  // Advance only over what was actually shown (server clock); when nothing is
  // shown keep the previous watermark so a file the server failed to return
  // still surfaces on the next listing. On the very first call with an empty
  // inbox the baseline becomes "now" so later arrivals count as new.
  const nextWatermark =
    visible.length > 0
      ? Math.max(watermark ?? 0, maxShownTs)
      : watermark ?? now.getTime();

  if (dated.length === 0) {
    return { text: "Inbox is empty.", shownCount: 0, hiddenCount: 0, nextWatermark };
  }

  // Age buckets over ALL files (shown + hidden) — the verdict warns about
  // stale content even when it is already hidden by the watermark.
  const dayMs = 86_400_000;
  const today = dated.filter((d) => d.ts > 0 && now.getTime() - d.ts < dayMs).length;
  const older = dated.length - today;

  const lines: string[] = [];
  const scope = includeOld
    ? "full listing (include_old=true)"
    : watermark === null
      ? "first listing this session — baseline set"
      : `${visible.length} new since your last listing`;
  lines.push(
    hiddenCount > 0
      ? `Inbox: ${visible.length} file(s) [${hiddenCount} old hidden — pass include_old=true to see them] (${scope})`
      : `Inbox: ${visible.length} file(s) (${scope})`,
  );
  lines.push(`now: ${fmtUtc(now)} | session started: ${fmtUtc(sessionStartedAt)}`);
  const bucket =
    `ages: today (<24h): ${today}` +
    (older > 0 ? `, older than 24h: ${older} (⚠ устарели, скорее всего неактуальны)` : "");
  lines.push(bucket);
  if (visible.length > 0) lines.push("");

  for (const d of visible) {
    const age = d.ts > 0 ? `${fmtAge(now.getTime() - d.ts)}, ${fmtUtc(new Date(d.ts))}` : "время неизвестно";
    lines.push(`• ${d.file.name} (${fmtSize(d.file.size)}, ${age}) — id: ${d.file.file_id}`);
  }
  if (hiddenCount > 0 && visible.length > 0) {
    lines.push(`… and ${hiddenCount} older file(s) hidden (include_old=true to list them)`);
  }

  return {
    text: lines.join("\n"),
    shownCount: visible.length,
    hiddenCount,
    nextWatermark,
  };
}
