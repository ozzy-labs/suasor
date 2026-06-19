/**
 * SSOT for the Slack feature → OAuth scope mapping + readiness assessment
 * (ADR-0011; port of opshub's `scopes.py` / opshub ADR-0040).
 *
 * This leaf module is the **single source of truth** for *which OAuth scopes
 * each Slack ingestion feature needs*. Other sites that need the mapping derive
 * from {@link FEATURE_SCOPES} (see {@link historyScopeForType}) rather than
 * restating it — a duplicated table would be a second SSOT that drifts.
 *
 * The readiness model is a **capability model**: {@link assessReadiness} answers
 * only "does this token's granted scope set satisfy feature X's *scope*
 * preconditions?" — it reads no config, resolves no channel membership, and
 * makes no API calls. Membership is a different layer (`not_in_channel`),
 * surfaced once as a footnote by {@link renderFeaturesBlock}.
 *
 * Import-clean: this module imports nothing — it is free to pull onto the
 * `suasor --help` cold-start path (ADR-0007).
 */

/** Slack token principal: a Bot Token (`xoxb`) or a User Token (`xoxp`). */
export type SlackPrincipal = "bot" | "user";

/** Ingestion features whose scope preconditions `slack auth test` reports on. */
export type SlackFeature =
  | "sync_public"
  | "sync_private"
  | "sync_dm"
  | "sync_mpim"
  | "engagement_axis";

/** The scope preconditions for one Slack feature (one SSOT row). */
export interface FeatureScopeSpec {
  /** Human display label shown in the `auth test` `features:` block. */
  readonly label: string;
  /** Scopes that MUST all be granted for the feature to work at all. */
  readonly required: readonly string[];
  /**
   * Scopes that improve the feature but are not load-bearing (e.g. `users:read`
   * resolves author display names). Absence downgrades the verdict to
   * `READY (degraded: …)` rather than `MISSING`.
   */
  readonly recommended: readonly string[];
  /**
   * `true` when the feature is only reachable with a User Token — a Bot Token
   * structurally cannot hold the scope (`search:read`, opshub ADR-0034).
   */
  readonly userTokenOnly: boolean;
}

/**
 * Feature → scope SSOT. Order is the display order of the `features:` block.
 */
export const FEATURE_SCOPES: Record<SlackFeature, FeatureScopeSpec> = {
  sync_public: {
    label: "public channel sync",
    required: ["channels:history"],
    recommended: ["users:read"],
    userTokenOnly: false,
  },
  sync_private: {
    label: "private channel sync",
    required: ["groups:history"],
    recommended: ["users:read"],
    userTokenOnly: false,
  },
  sync_dm: {
    label: "DM sync",
    required: ["im:history"],
    recommended: ["users:read"],
    userTokenOnly: false,
  },
  sync_mpim: {
    label: "group-DM (mpim) sync",
    required: ["mpim:history"],
    recommended: ["users:read"],
    userTokenOnly: false,
  },
  engagement_axis: {
    label: "engagement axis (search:read)",
    required: ["search:read"],
    recommended: [],
    userTokenOnly: true,
  },
};

/** Conversation type → the feature whose `required[0]` is that type's `*:history` scope. */
const TYPE_TO_FEATURE: Record<string, SlackFeature> = {
  public: "sync_public",
  private: "sync_private",
  im: "sync_dm",
  mpim: "sync_mpim",
};

/**
 * The `*:history` scope required to fetch `conversationType`. The single
 * derivation of the type → history-scope mapping (drift removal).
 *
 * @throws {Error} for an unknown conversation type.
 */
export function historyScopeForType(conversationType: string): string {
  const feature = TYPE_TO_FEATURE[conversationType];
  if (!feature) throw new Error(`unknown conversation type: ${conversationType}`);
  return FEATURE_SCOPES[feature].required[0] as string;
}

/** The assessed readiness of one feature for a given token. */
export interface FeatureReadiness {
  readonly feature: SlackFeature;
  readonly label: string;
  /** `true` for READY and degraded-READY. */
  readonly ready: boolean;
  /** Fully-rendered display string (`READY` / `MISSING …` / `N/A …` / `READY (degraded: …)`). */
  readonly status: string;
  /** Unmet **required** scopes (empty unless the status is MISSING). */
  readonly missing: readonly string[];
}

/** Parse a comma-separated `x-oauth-scopes` value into a set of granted scopes. */
function parseGranted(scopes: string): Set<string> {
  return new Set(
    scopes
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Assess each feature's *scope* readiness from a token's granted scopes.
 *
 * Pure function: takes the comma-separated `scopes` string and `principal` and
 * returns one {@link FeatureReadiness} per feature, in {@link FEATURE_SCOPES}
 * order. No I/O, no config, no API calls — a scope-layer capability model only
 * (ADR-0011). An empty `scopes` yields all-`MISSING` rows; the CLI
 * short-circuits that case via {@link renderFeaturesBlock}.
 */
export function assessReadiness(scopes: string, principal: SlackPrincipal): FeatureReadiness[] {
  const granted = parseGranted(scopes);
  const results: FeatureReadiness[] = [];
  for (const [feature, spec] of Object.entries(FEATURE_SCOPES) as [
    SlackFeature,
    FeatureScopeSpec,
  ][]) {
    if (spec.userTokenOnly && principal === "bot") {
      results.push({
        feature,
        label: spec.label,
        ready: false,
        status: "N/A (User Token only)",
        missing: [],
      });
      continue;
    }
    const missing = spec.required.filter((s) => !granted.has(s));
    if (missing.length > 0) {
      results.push({
        feature,
        label: spec.label,
        ready: false,
        status: `MISSING ${missing.join(" ")}`,
        missing,
      });
      continue;
    }
    const missingRecommended = spec.recommended.filter((s) => !granted.has(s));
    if (missingRecommended.length > 0) {
      const detail = missingRecommended.map((s) => `+${s}`).join(" ");
      results.push({
        feature,
        label: spec.label,
        ready: true,
        status: `READY (degraded: ${detail} for display names)`,
        missing: [],
      });
      continue;
    }
    results.push({ feature, label: spec.label, ready: true, status: "READY", missing: [] });
  }
  return results;
}

/**
 * Surfaced once at the foot of the `features:` block. Readiness is a scope
 * verdict only; a granted scope does not imply the token can read a given
 * channel (membership is a separate layer — ADR-0011).
 */
const MEMBERSHIP_FOOTNOTE =
  "  note: READY = scope granted; it does not guarantee channel membership — " +
  "a channel you have not joined, or a bot not /invite'd, still returns not_in_channel.";

/**
 * Render the `features:` block **body** for `auth test` (the lines after the
 * header). Handles the scopes-unavailable degrade (Slack omitted the
 * `x-oauth-scopes` header → empty `scopes`): a single explanatory line instead
 * of per-feature verdicts. Otherwise one `  <label>: <status>` line per feature
 * plus the membership footnote.
 */
export function renderFeaturesBlock(scopes: string, principal: SlackPrincipal): string[] {
  if (scopes.trim().length === 0) {
    return ["  (scopes header unavailable — cannot assess readiness)"];
  }
  const lines = assessReadiness(scopes, principal).map((r) => `  ${r.label}: ${r.status}`);
  lines.push(MEMBERSHIP_FOOTNOTE);
  return lines;
}
