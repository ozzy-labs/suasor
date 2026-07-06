/**
 * Digest run orchestration (ADR-0040): turn configured standing-consent jobs into
 * deliveries. One cron one-shot (`suasor digest`) resolves each job's content
 * (the ADR-0041 scorer top-N + brief warnings), renders it, resolves the channel
 * target (paths / secrets), and dispatches. With no jobs it does nothing — the
 * "事前同意のない通知なし" boundary (ADR-0040 §2).
 *
 * Side effects (fs / notifier / network / keychain) are injected so the whole
 * orchestration is unit-testable end-to-end via the file channel and fakes.
 */
import type { Database } from "bun:sqlite";
import type { DigestJob } from "../config/schema.ts";
import type { BriefWarning } from "../mcp/queries.ts";
import {
  DigestChannelError,
  type DigestDeliveryDeps,
  type DigestTarget,
  deliverDigest,
} from "./channels.ts";
import { buildDigest, type Digest, renderDigestNotification, renderDigestText } from "./content.ts";

/** Outcome of one job in a digest run. */
export interface DigestJobResult {
  /** The job name. */
  job: string;
  /** The job's channel. */
  channel: DigestJob["channel"];
  /** `delivered` (pushed), `skipped` (dry-run, rendered only), or `failed`. */
  status: "delivered" | "skipped" | "failed";
  /** Where it landed (file path / notifier / Slack channel), when delivered. */
  detail?: string;
  /** Stable error code (ADR-0036), when failed. */
  errorCode?: string;
  /** Human error message, when failed (never contains a secret). */
  error?: string;
  /** The rendered digest bundle (for `--json` / dry-run inspection). */
  digest: Digest;
}

export interface RunDigestOptions {
  /** Reference "now" for the scorer (ISO 8601; injectable for tests). */
  now?: string;
  /** Render only, do not deliver (each job → `skipped`). */
  dryRun?: boolean;
  /** Run only the named job (else every configured job). */
  jobName?: string;
  /** Operator Slack user ids for demand `<@you>` mentions (scorer). */
  selfUserIds?: string[];
  /** Brief completeness warnings (#189), resolved from config by the caller. */
  warnings?: BriefWarning[];
  /** Absolute export sandbox dir (`config.export.dir`) for the file channel. */
  exportDir: string;
  /** `[connectors.local].roots` — the file channel must not write into any. */
  localRoots?: string[];
  /** Resolve a workspace's Slack token from the keychain (slack-dm channel). */
  resolveSlackToken?: (workspace?: string) => Promise<string | null>;
  /** Resolve a workspace's Slack self user id from config (slack-dm channel). */
  resolveSlackSelfId?: (workspace?: string) => string | null;
  /** Slack API base override (tests). */
  slackApiBase?: string;
  /** Injectable channel side-effect deps (tests). */
  deliveryDeps?: DigestDeliveryDeps;
}

/** Resolve a job's channel into a concrete delivery target. */
async function resolveTarget(job: DigestJob, options: RunDigestOptions): Promise<DigestTarget> {
  switch (job.channel) {
    case "file":
      return {
        kind: "file",
        dir: options.exportDir,
        filename: job.filename ?? `${job.name}.md`,
        ...(options.localRoots ? { localRoots: options.localRoots } : {}),
      };
    case "os-notification":
      return { kind: "os-notification" };
    case "slack-dm": {
      const token = (await options.resolveSlackToken?.(job.workspace)) ?? "";
      const selfUserId = options.resolveSlackSelfId?.(job.workspace) ?? "";
      return {
        kind: "slack-dm",
        token,
        selfUserId,
        ...(options.slackApiBase ? { apiBase: options.slackApiBase } : {}),
      };
    }
  }
}

/**
 * Run the configured digest jobs (ADR-0040). Returns one {@link DigestJobResult}
 * per job attempted (empty when no jobs / the named job is absent). A single job
 * failing does not abort the others — each failure is captured with its code, so
 * one broken channel never silences the rest.
 */
export async function runDigest(
  sqlite: Database,
  jobs: DigestJob[],
  options: RunDigestOptions,
): Promise<DigestJobResult[]> {
  const selected = options.jobName ? jobs.filter((j) => j.name === options.jobName) : jobs;
  const results: DigestJobResult[] = [];

  for (const job of selected) {
    const digest = buildDigest(sqlite, {
      ...(options.now !== undefined ? { now: options.now } : {}),
      limit: job.limit,
      ...(options.selfUserIds !== undefined ? { selfUserIds: options.selfUserIds } : {}),
      ...(options.warnings !== undefined ? { warnings: options.warnings } : {}),
    });
    const payload = {
      text: renderDigestText(digest, { title: job.name }),
      notification: renderDigestNotification(digest, { title: job.name }),
    };

    if (options.dryRun) {
      results.push({ job: job.name, channel: job.channel, status: "skipped", digest });
      continue;
    }

    try {
      const target = await resolveTarget(job, options);
      const delivery = await deliverDigest(target, payload, options.deliveryDeps);
      results.push({
        job: job.name,
        channel: job.channel,
        status: "delivered",
        detail: delivery.detail,
        digest,
      });
    } catch (err) {
      const code = err instanceof DigestChannelError ? err.code : "UNKNOWN";
      results.push({
        job: job.name,
        channel: job.channel,
        status: "failed",
        errorCode: code,
        error: err instanceof Error ? err.message : String(err),
        digest,
      });
    }
  }
  return results;
}
