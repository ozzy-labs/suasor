/**
 * Digest content composition (ADR-0040 §4 / ADR-0041).
 *
 * A digest is a *bundle*, not a summary: it composes the deterministic priority
 * scorer's top-N (ADR-0041 — overdue tasks/commitments at the top, then un-acked
 * demand, then due-soon / priority / recency) with the brief's completeness
 * warnings (ADR-0017 / #189 — data-freshness / not-configured signals). No LLM in
 * the loop (ADR-0006 ML delegation): the host, if any, summarises out of process.
 *
 * The proactive push lane (ADR-0040) renders this bundle to text and pushes it to
 * a configured channel on a cron one-shot. This module is pure (SELECT + in-memory
 * shaping); channels / config / egress live in `./channels.ts` / the CLI command.
 */
import type { Database } from "bun:sqlite";
import {
  type BriefWarning,
  buildPriorities,
  type Priorities,
  type PriorityItem,
} from "../mcp/queries.ts";

/** A rendered, channel-ready digest bundle (ADR-0040). */
export interface Digest {
  /** The `now` the scorer's overdue / freshness derivation used (ISO 8601). */
  generatedAt: string;
  /** The ranked cross-entity rows (scorer top-N, ADR-0041). */
  priorities: PriorityItem[];
  /** Completeness warnings (empty categories that are *unconfigured*, #189). */
  warnings: BriefWarning[];
  /** `true` when more candidates matched than `limit` returned (ADR-0007). */
  truncated: boolean;
}

export interface BuildDigestOptions {
  /** Reference "now" for overdue / freshness (ISO 8601; injectable for tests). */
  now?: string;
  /** Top-N ranked rows to include (scorer limit). */
  limit?: number;
  /** Operator Slack user ids for demand `<@you>` mentions (ADR-0012). */
  selfUserIds?: string[];
  /**
   * Completeness warnings (#189). Caller-supplied so the composer stays pure
   * (no config knowledge); derive via `deriveBriefWarnings`.
   */
  warnings?: BriefWarning[];
}

/**
 * Compose the default digest content (ADR-0040 §4): the priority scorer's top-N
 * (which already folds overdue tasks/commitments, un-acked demand, and due-soon
 * commitments into one ranked list, ADR-0041) plus the brief's completeness
 * warnings. Pure — the caller resolves `selfUserIds` / `warnings` from config.
 */
export function buildDigest(sqlite: Database, options: BuildDigestOptions = {}): Digest {
  const priorities: Priorities = buildPriorities(sqlite, {
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.selfUserIds !== undefined ? { selfUserIds: options.selfUserIds } : {}),
  });
  return {
    generatedAt: priorities.now,
    priorities: priorities.items,
    warnings: options.warnings ?? [],
    truncated: priorities.truncated,
  };
}

/** `true` when the digest has nothing to surface (no rows, no warnings). */
export function isDigestEmpty(digest: Digest): boolean {
  return digest.priorities.length === 0 && digest.warnings.length === 0;
}

export interface RenderDigestOptions {
  /** Header label (e.g. the job name); omitted → a plain "Suasor digest" header. */
  title?: string;
}

/**
 * Render a digest to a human-readable, non-interactive text block (the file /
 * Slack channel payload). Each priority row is prefixed with its scorer `reason`
 * so the "why it ranked here" is visible without a host LLM. Deterministic given
 * the same digest.
 */
export function renderDigestText(digest: Digest, options: RenderDigestOptions = {}): string {
  const header = options.title ? `Suasor digest — ${options.title}` : "Suasor digest";
  const lines: string[] = [header, digest.generatedAt, ""];

  if (digest.priorities.length === 0) {
    lines.push("Priorities: none");
  } else {
    const suffix = digest.truncated ? "+" : "";
    lines.push(`Priorities (${digest.priorities.length}${suffix}):`);
    for (const item of digest.priorities) {
      lines.push(`  ${item.rank}. [${item.reason}] ${item.title} — ${item.explanation}`);
    }
  }

  if (digest.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of digest.warnings) {
      lines.push(`  ⚠ ${warning.key}: ${warning.message}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/** A short OS-notification payload (title + one-line body). */
export interface DigestNotification {
  title: string;
  body: string;
}

/**
 * Render the compact notification form (OS notifiers truncate aggressively, so a
 * digest degrades to a count + the single top row). Falls back to a quiet
 * "nothing needs attention" body when empty.
 */
export function renderDigestNotification(
  digest: Digest,
  options: RenderDigestOptions = {},
): DigestNotification {
  const title = options.title ? `Suasor digest — ${options.title}` : "Suasor digest";
  if (isDigestEmpty(digest)) {
    return { title, body: "Nothing needs your attention right now." };
  }
  const parts: string[] = [];
  if (digest.priorities.length > 0) {
    const suffix = digest.truncated ? "+" : "";
    const top = digest.priorities[0];
    parts.push(
      `${digest.priorities.length}${suffix} priorit${digest.priorities.length === 1 ? "y" : "ies"}` +
        (top ? ` · top: ${top.title}` : ""),
    );
  }
  if (digest.warnings.length > 0) {
    parts.push(`${digest.warnings.length} warning${digest.warnings.length === 1 ? "" : "s"}`);
  }
  return { title, body: parts.join(" · ") };
}
