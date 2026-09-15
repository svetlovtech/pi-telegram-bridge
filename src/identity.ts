// ──────────────────────────────────────────────────────────────────────────
// pi-telegram-bridge — agent identity for outbound Telegram messages
//
// Derives a short "who is this / what project" prefix so the user can tell in
// Telegram which agent and which repo a message/question came from.
//
// NOTE: The chat-service may provide an `agent` field so the server-side
// prefix is authoritative; until then this module provides a local fallback:
// we prefix the header/question text ourselves.
// ──────────────────────────────────────────────────────────────────────────
import { basename } from "node:path";

export interface AgentIdentity {
  kind: string;
  name: string;
  project: string | null;
  /** Short display string, e.g. "pi · my-repo" or "pi". */
  label: string;
}

let cached: AgentIdentity | null = null;

/**
 * Build the agent identity once per process.
 *
 *  - name: "pi" (the harness); could be overridden by env if needed.
 *  - project: basename of the workspace cwd (env PI/cwd or process.cwd).
 */
export function getAgentIdentity(): AgentIdentity {
  if (cached) return cached;

  const project =
    process.env.PI_PROJECT ||
    projectFromCwd(process.env.PI_CWD || process.cwd());

  const identity: AgentIdentity = {
    kind: "pi",
    name: "pi",
    project,
    label: project ? `pi · ${project}` : "pi",
  };
  cached = identity;
  return identity;
}

function projectFromCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  try {
    const name = basename(cwd);
    return name && name !== "/" && name !== "." ? name : null;
  } catch {
    return null;
  }
}

/** Prefix to prepend to a quarantine/notification as a source tag. */
export function agentPrefix(): string {
  const id = getAgentIdentity();
  return id.label;
}

/** Prepend the source tag to a `header` string (idempotent-ish). */
export function tagHeader(header: string): string {
  const id = getAgentIdentity();
  if (!id.project) return header;
  // Avoid double-prefixing if the header already carries the source tag.
  if (/^pi · /.test(header)) return header;
  return `${id.label} · ${header}`;
}
