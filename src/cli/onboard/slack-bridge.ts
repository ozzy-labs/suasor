/**
 * Slack's connector-specific onboarding bridge (Issue #384 / #458).
 *
 * Slack keeps its own auth flow (`slack auth set/test`, ADR-0011/0042) instead
 * of the generic `AUTH_SPECS` verbs, so the onboard wizard bridges that flow
 * inline: token pool → auth-test readiness → suggest-and-confirm channels →
 * config slice. Extracted from `commands/onboard.ts` (where it lived as five
 * private methods) into the data-driven bridge registry (`bridges.ts`), keyed
 * off the manifest's `connectorSpecificOnboard` declaration — the same
 * owned-vs-declared split the other manifest surfaces use (#440): the manifest
 * *declares* the capability, the behaviour lives here in the CLI layer
 * (connectors never depend on the cli layer).
 *
 * Lazy-import discipline (NFR-PRF-1): heavy modules load inside the functions.
 */
import { readPlainLine, readSecretLine } from "../read-secret.ts";
import type { OnboardBridge, OnboardBridgeDeps } from "./bridges.ts";

const SLACK = "slack";

/**
 * Migration checklist surfaced when a legacy ADR-0014 multi-workspace Slack
 * config (`[connectors.slack.workspaces.<alias>]`) is detected. The shape was
 * removed by ADR-0042 (flat channels + unnamed token pool); sync fails loudly on
 * it, so onboard points at the mechanical migration instead of bridging it.
 */
const SLACK_LEGACY_CONFIG_STEPS: readonly string[] = [
  "# migrate config.toml: merge every workspace's channel ids into one flat [connectors.slack] channels list",
  "#   (drop 'workspaces' tables, 'team', 'self_user_id'; per-alias since → [connectors.slack.channel_since])",
  "suasor slack auth set          # store every workspace's token as one pool (comma/newline separated)",
  "suasor slack auth test         # verify each pool token + scope readiness",
  "suasor slack conversations     # list channels across the pool; paste the block",
  "suasor slack sync",
];

/** The slack onboarding bridge (registered in `bridges.ts`). */
export const slackOnboardBridge: OnboardBridge = {
  connector: SLACK,
  run: runSlackBridge,
};

/**
 * Bridge slack's setup inline: (a) store the token pool, (b) run the auth-test
 * readiness probe, (c) append the `[connectors.slack]` slice via the
 * suggest-and-confirm channel discovery (ADR-0042 決定 6). A legacy ADR-0014
 * multi-workspace config is not bridged — it records the migration checklist
 * and leaves the config untouched.
 *
 * Returns an exit code to abort the wizard (a missing token on a non-TTY), or
 * `undefined` to continue. `deps.report` is mutated in place; the token is
 * never echoed.
 */
async function runSlackBridge(deps: OnboardBridgeDeps): Promise<number | undefined> {
  const { stdout, stderr } = deps;
  const [{ SLACK_TOKENS_SECRET }, { resolveSecret, storeSecret, storeSecretErrorMessage }] =
    await Promise.all([import("../../connectors/slack.ts"), import("../../connectors/secrets.ts")]);
  const secretName = SLACK_TOKENS_SECRET; // the unnamed token pool (ADR-0042)

  // A legacy ADR-0014 multi-workspace config cannot be driven (or synced) —
  // point at the ADR-0042 migration and leave the config untouched.
  const aliases = await legacyWorkspaceAliases();
  if (aliases.length > 0) {
    deps.manualSteps.set(SLACK, SLACK_LEGACY_CONFIG_STEPS);
    if (!deps.json) {
      stdout.write(
        `slack: legacy multi-workspace config detected (${aliases.join(", ")}) — migrate to ` +
          "the flat ADR-0042 shape first (checklist below).\n",
      );
    }
    return undefined;
  }

  // (a) token pool (unless --skip-auth, where it comes from the env override /
  // binary). Line-based, echo-suppressed read (Issue #383): resolves on Enter
  // on a TTY and never echoes the token.
  if (!deps.skipAuth) {
    if (deps.interactive) {
      stdout.write(
        "Paste the slack token(s) and press Enter — multiple tokens comma-separated " +
          "(the pool is replaced as a whole):\n",
      );
    }
    const token = (await readSecretLine(deps.stdin, stderr, { mask: true })).trim();
    if (!token) {
      stderr.write(
        "error: no token provided for slack " +
          "(pipe it on stdin, or use --skip-auth with SUASOR_CONNECTOR_SLACK_TOKENS)\n",
      );
      return 1;
    }
    try {
      await storeSecret(SLACK, secretName, token, deps.keychain ? { keychain: deps.keychain } : {});
    } catch (cause) {
      // Headless host (Docker / server): no Secret Service — surface the
      // env-override recovery instead of the raw native error (Issue #557).
      stderr.write(storeSecretErrorMessage(SLACK, secretName, cause));
      stderr.write("hint: then re-run this wizard with --skip-auth\n");
      return 1;
    }
    deps.report.authStored = true;
    if (!deps.json) stdout.write("slack: token stored in the OS keychain.\n");
  }

  // Resolve the effective token for the probes (env override wins, then the
  // keychain). Used for both the auth-test readiness display and the discovery
  // leaf below; never printed.
  const token = await resolveSecret(SLACK, secretName);

  // (b) auth test probe — verify + per-feature scope readiness. Also yields the
  // team id the discovery step may use.
  const teamId = await slackAuthTest(deps, token);

  // (c) config slice — the joined channels via suggest-and-confirm, or the
  // placeholder template when discovery is unavailable / fails.
  await appendSlackConfigSlice(deps, token, teamId);
  return undefined;
}

/**
 * The configured legacy `[connectors.slack.workspaces.<alias>]` aliases.
 * Reads the RAW config file (not `loadConfig`): the loader itself rejects the
 * legacy ADR-0014 shape, so a legacy config would throw before this detector
 * could route to the migration checklist. Any read/parse failure degrades to
 * `[]` (treat as flat) — the flat bridge is non-destructive.
 */
async function legacyWorkspaceAliases(): Promise<string[]> {
  try {
    const [{ resolveConfigDir }, { join }] = await Promise.all([
      import("../../config/index.ts"),
      import("node:path"),
    ]);
    const file = Bun.file(join(resolveConfigDir(process.env), "config.toml"));
    if (!(await file.exists())) return [];
    const parsed = Bun.TOML.parse(await file.text()) as {
      connectors?: { slack?: { workspaces?: Record<string, unknown> } };
    };
    return Object.keys(parsed.connectors?.slack?.workspaces ?? {});
  } catch {
    return [];
  }
}

/**
 * Run slack's `auth test` probe (`testToken`, the same round-trip `slack auth
 * test` uses) and render the per-feature scope readiness. Returns the resolved
 * team id, or `undefined` when there is no token or the probe fails. Under
 * `--skip-auth` the probe is still run for the team id but its outcome is not
 * reported (parity with the generic `--skip-auth` path).
 */
async function slackAuthTest(
  deps: OnboardBridgeDeps,
  token: string | null,
): Promise<string | undefined> {
  if (!token) return undefined;
  const { testToken } = await import("../../connectors/slack/auth.ts");
  try {
    const result = await testToken(token);
    if (!deps.skipAuth) {
      deps.report.authTest = "ok";
      deps.report.authTestDetail = `${result.principal} @ ${result.team} (${result.teamId})`;
      if (!deps.json) {
        const { renderFeaturesBlock } = await import("../../connectors/slack/scopes.ts");
        deps.stdout.write(
          `slack: auth test ok — ${result.principal} token for ${result.user} @ ${result.team} (${result.teamId}).\n`,
        );
        deps.stdout.write("slack: scope readiness —\n");
        for (const line of renderFeaturesBlock(result.scopes, result.principal)) {
          deps.stdout.write(`${line}\n`);
        }
      }
    }
    return result.teamId;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!deps.skipAuth) {
      deps.report.authTest = "failed";
      deps.report.authTestDetail = message;
      if (!deps.json) {
        deps.stdout.write(
          `slack: auth test FAILED — ${message} (token saved; fix and re-run \`suasor slack auth test\`).\n`,
        );
      }
    }
    return undefined;
  }
}

/**
 * Append the `[connectors.slack]` slice (non-destructive, ADR-0029 §3). When
 * the token resolved, enumerate the joined channels and apply them via the same
 * surgical editor `slack follow` uses, with suggest-and-confirm semantics
 * (ADR-0042 決定 6 / #472): interactive runs list the channels and take ONE
 * confirmation; non-interactive / --json runs apply directly (the wizard
 * invocation is the consent). Otherwise append the placeholder template with
 * the reason on stderr.
 */
async function appendSlackConfigSlice(
  deps: OnboardBridgeDeps,
  token: string | null,
  _teamId: string | undefined,
): Promise<void> {
  const [{ resolveConfigDir }, configAppend, { join }] = await Promise.all([
    import("../../config/index.ts"),
    import("./config-append.ts"),
    import("node:path"),
  ]);
  const configPath = join(resolveConfigDir(process.env), "config.toml");
  const file = Bun.file(configPath);
  const current = (await file.exists()) ? await file.text() : "";

  // Non-destructive: an existing [connectors.slack] (including enabled = false)
  // is never rewritten (ADR-0029 §3). Add channels later with
  // `suasor slack follow --suggest`.
  if (configAppend.hasConnectorSlice(current, SLACK)) {
    deps.report.configAppended = false;
    deps.report.configSource = "skipped";
    if (!deps.json) {
      deps.stdout.write("slack: [connectors.slack] already in config.toml (left untouched).\n");
    }
    return;
  }

  const discovery = token ? await discoverJoinedChannels(token) : null;
  if (discovery && "entries" in discovery) {
    let apply = true;
    if (deps.interactive && !deps.json && discovery.entries.length > 0) {
      deps.stdout.write(
        `slack: ${discovery.entries.length} joined channel(s) not yet configured:\n`,
      );
      for (const e of discovery.entries) {
        deps.stdout.write(`  ${e.id}${e.label ? `  ${e.label}` : ""}\n`);
      }
      deps.stderr.write("Add these to [connectors.slack].channels? [Y/n] ");
      const answer = (await readPlainLine(deps.stdin, deps.stderr)).trim().toLowerCase();
      deps.stderr.write("\n");
      apply = answer === "" || answer === "y" || answer === "yes";
    }
    if (apply) {
      const { addSlackChannels } = await import("../slack-channels-edit.ts");
      const result = addSlackChannels(current, discovery.entries);
      if (result.added.length > 0) await Bun.write(configPath, result.toml);
      deps.report.configAppended = result.added.length > 0;
      deps.report.configSource = "discovery";
      deps.report.discovered = discovery.entries.length;
      if (!deps.json) {
        deps.stdout.write(
          `slack: discovered ${discovery.entries.length} joined channel(s); appended [connectors.slack] to config.toml.\n`,
        );
      }
      return;
    }
    // Declined: fall through to the placeholder template with a follow hint.
    deps.stderr.write(
      "slack: channel selection skipped — add channels later with `suasor slack follow --suggest`.\n",
    );
  }

  // No token / probe failed / declined → minimal placeholder template.
  const result = configAppend.appendConnectorSlice(current, SLACK);
  if (result.appended) await Bun.write(configPath, result.toml);
  deps.report.configAppended = result.appended;
  deps.report.configSource = "template";
  if (!deps.json) {
    deps.stdout.write("slack: appended [connectors.slack] (enabled = true) to config.toml.\n");
  }
  const reason =
    discovery && "error" in discovery ? discovery.error : "no token resolved for slack";
  // A declined interactive confirmation also lands here; its own hint (`slack
  // follow --suggest`) was already printed above.
  if (!discovery || "error" in discovery) {
    deps.stderr.write(
      `slack: discovery skipped (${reason}); wrote the placeholder slice — ` +
        "edit it by hand or re-run `suasor slack conversations`.\n",
    );
    deps.discoverySkips.set(SLACK, "conversations");
  }
}

/**
 * Enumerate the joined channels the slack token can see (`listConversations`,
 * the same leaf `slack conversations` uses). Best-effort + read-only; the token
 * is never echoed. Restricted to public + private member channels — the "what
 * belongs in `channels`" convention (ADR-0039); DMs / group-DMs stay opt-in via
 * `slack follow`. Returns `{ error }` on a probe failure so the caller falls
 * back to the placeholder template.
 */
async function discoverJoinedChannels(
  token: string,
): Promise<{ entries: { id: string; label?: string }[] } | { error: string }> {
  const { listConversations } = await import("../../connectors/slack/conversations.ts");
  try {
    const result = await listConversations(token, { types: ["public", "private"] });
    const joined = result.conversations.filter((c) => c.isMember);
    return {
      entries: joined.map((c) => ({
        id: c.id,
        ...(c.displayName ? { label: c.displayName } : {}),
      })),
    };
  } catch (cause) {
    return { error: cause instanceof Error ? cause.message : String(cause) };
  }
}
