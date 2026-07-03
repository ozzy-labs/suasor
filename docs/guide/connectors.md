# Connectors

A connector is the shared implementation that ingests from a source **read-only** ([ADR-0007](../adr/0007-connector-contract.md) / [connector-contract](../design/connector-contract.md)). Ingested items are appended as events, their bodies are kept in a local projection, and they become searchable via FTS ([ADR-0002](../adr/0002-event-sourced-architecture.md) / [ADR-0003](../adr/0003-local-first-and-content-minimization.md)).

There are two ways to trigger ingestion. Both call the same sync service:

- CLI: `suasor <connector> sync`
- MCP write tool: `connector.sync` (HITL. Never runs without human approval. [mcp-surface](../design/mcp-surface.md))

## An empty (no-op) config is warned before sync

Even when a connector is **enabled** (a `[connectors.X]` section exists and is not `enabled = false`), if its ingest scope is empty (github with `repos` unset and `notifications = "off"`, box with `folders` unset, local with `roots` unset, web with `urls` unset, google / ms-graph with an **explicit** `resources = []`, notion with `databases` unset and `pages = false`, jira with `projects` unset and `jql` unset, slack with no workspace declaring `channels`), sync silently finishes with 0 observed and you cannot notice until you inspect the DB ([#187](https://github.com/ozzy-labs/suasor/issues/187)). To prevent this, sync detects an empty config before running and prints a warning to stderr (e.g. `warning: github: repos unset and notifications=off — nothing to ingest (set repos in config, or set notifications to all/repos)`).

- The same warning appears on both paths: single sync (`suasor <connector> sync`) and bulk sync (`suasor sync`, [ADR-0027](../adr/0027-bulk-sync-orchestration.md))
- It is **warning-only** and does not change the exit code (an empty config is not a failure; the run succeeds normally with `0 observed`)

## Start with `suasor onboard` (recommended setup path)

Before configuring connectors one by one by hand, the interactive wizard **`suasor onboard`** stitches the correct order (connector selection → token storage → `auth test` round-trip → appending the `[connectors.X]` slice → first sync → scheduler scaffold → MCP registration) into a single command ([ADR-0029](../adr/0029-onboarding-wizard.md)).

In particular, it structurally resolves a common pitfall where **you save a token with `auth set` but forget to write `[connectors.X] enabled=true`, so `suasor sync` silently does nothing** (it automates appending the config slice too; existing sections are left intact).

```bash
suasor onboard --connector github            # interactive (TTY). token from stdin
suasor onboard --connector github,slack --json   # non-interactive, machine-readable summary
suasor onboard --connector box --skip-auth   # token via env override (headless / binary)
```

- On a **non-interactive terminal** (pipe / CI) `--connector` is required (it shows no prompt; "no silent wrong answer")
- The token is stored in the keychain and never written to `config.toml` (secrets live in the keychain / env override, NFR-PRV-4)
- Config edits are **append-only at the end** and do not break existing hand-written comments or other sections. If `[connectors.X]` already exists (including with `enabled = false`) it is left untouched (idempotent)

### discovery integration (automatic id discovery for non-Slack connectors, [ADR-0030](../adr/0030-connector-discovery-verbs.md) / #195)

When you onboard a connector that has a discovery verb (**github** = `repos` / **google** = `calendars` / **box** = `folders` / **notion** = `databases` / **jira** = `projects`), the wizard runs its discovery probe after `auth test`, enumerates the ids visible from the token, generates a `[connectors.X]` block (with an id array such as `repos = [...]`), and appends it non-destructively. Because `config.toml` gets not just `enabled = true` but also the **ingest target ids**, setup completes without fishing for ids by hand (avoiding silent 0 counts from typos).

- For a discovery-capable connector where the **token can be resolved** (keychain / env override) → it runs discovery and appends a block containing the discovered ids (`--json` reports `configSource` as `"discovery"` and a count in `discovered`)
- Even for a discovery-capable connector, when the **token is missing / the probe fails** → it falls back to appending a minimal template slice (required keys as comment stubs) and prints the reason to stderr (`configSource` is `"template"`). You can run `suasor <connector> <verb>` by hand later and swap it in
- **Connectors without discovery** (slack / ms-graph / web / local) → as before, a template slice with comment stubs is appended (`configSource` is `"template"`)
- If a slice already exists, discovery is not run and it is preserved non-destructively (`configSource` is `"skipped"`)

```bash
# pass the token via env override, discover github repos, and paste into config (headless)
SUASOR_CONNECTOR_GITHUB_TOKEN=ghp_xxx suasor onboard --connector github --skip-auth --json
```

The following per-connector sections show the details for configuring by hand without the wizard (token kind, required config keys).

## GitHub

Ingests GitHub issues / pull requests (`octokit`).

### 1. Prepare a token

Issue a GitHub Personal Access Token (fine-grained recommended, with **Issues: read-only** / **Pull requests: read-only** permission on the target repositories).

The token can be provided via two paths (**never written to config.toml**). Precedence is env override > keychain ([config](../design/config.md) / NFR-PRV-4):

- **OS keychain** (default, recommended): stored under service `suasor` / account `connector:github:token`
- **env override** (for headless / Docker): `SUASOR_CONNECTOR_GITHUB_TOKEN`

```bash
# env override example
export SUASOR_CONNECTOR_GITHUB_TOKEN="github_pat_..."
```

Storing into the keychain and verification are done with dedicated CLI verbs (Issue #85; the operational verbs from [ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) extended beyond Slack):

```bash
suasor github auth set                 # save the PAT to the keychain (stdin / --token)
suasor github auth test                # verify the PAT + login + granted scopes + feature readiness
```

`auth set` saves the token to `connector:github:token` (service `suasor`) (reusing `storeSecret`; never written to `config.toml`). `auth test` verifies login and granted scopes (`x-oauth-scopes`) with a single `GET /user` (read-only, never leaks the token in errors, does not even load octokit — `fetch` only). It can still be provided via env override (`SUASOR_CONNECTOR_GITHUB_TOKEN`).

`auth test` prints per-feature readiness derived from granted scopes (a `features:` block) in the same format as Slack (Issue #194, [ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)). For github it evaluates `issue / pull request read` (`repo` scope) and, only when `notifications != "off"`, `notifications stream` (`notifications` or `repo` scope). A fine-grained PAT does not return `x-oauth-scopes` (scopes not enumerated), so each line is `N/A (scopes not enumerated)` (validity is already confirmed by the `GET /user` round-trip):

```text
ok: github credential for octocat
scopes: repo, read:org, notifications
features:
  issue / pull request read: READY
  notifications stream: READY
```

### 2. Discover target repositories (discovery)

Hand-copying the `owner/repo` you write in `repos` from the Web UI easily produces a typo that makes sync **silently return 0** (violating "no silent wrong answer" from [ADR-0007](../adr/0007-connector-contract.md)). Use the discovery verb that enumerates repositories visible from the token so you can paste them (the equivalent of Slack's `slack conversations`, [ADR-0030](../adr/0030-connector-discovery-verbs.md)):

```bash
suasor github repos                    # enumerate visible repositories and print a [connectors.github] block
suasor github repos --filter acme      # filter by substring match on full_name (case-insensitive)
suasor github repos --json             # print items + configBlock as JSON
```

It enumerates via `GET /user/repos` (Link-header pagination) with `fetch` only (no octokit dependency, import-clean, [ADR-0007](../adr/0007-connector-contract.md)) and prints `owner/repo` / visibility (public/private) / archived. The paste-ready `[connectors.github]` block at the end of the output can be pasted straight into config.toml (`repos` is the **full name**, and the `#` comment on each line is the visibility label). The token is resolved from keychain + env override (the same `token` as `auth set`) and is never leaked in errors.

### 3. Configure target repositories

Add `[connectors.github]` to `~/.config/suasor/config.toml` (overridable with `SUASOR_CONFIG_DIR`) — paste the output of `github repos` above and adjust `state` / `notifications`:

```toml
[connectors.github]
repos = ["owner/repo", "owner/another-repo"]  # ingest targets (discovered via github repos)
state = "all"                                  # open | closed | all (default all)
notifications = "off"                          # off | all | repos (default off)
# baseUrl = "https://github.example.com/api/v3"  # for GitHub Enterprise
```

When `repos` is empty and `notifications = "off"`, nothing is ingested (and no token is required).

#### notifications (per-token notification stream)

Enabling `notifications` ingests `GET /notifications` (a personal stream of mentions / review requests / assigns addressed to you) (Issue #93). This is a **per-token, not per-repo** stream, with a cursor on a separate axis from the `repos` allowlist. It is read-only (it only reads the thread list and never marks anything read).

- `off` (default): not ingested (keeps the existing issue / PR-only behavior)
- `all`: ingest notifications from all notified repos (including repos not in `repos`)
- `repos`: ingest only notifications from repos in the `repos` allowlist (the cursor advances even for filtered-out threads, preventing a re-flood next time)

`notifications = "all"` works on its own even when `repos` is empty (ingesting only the token's notification stream). PAT scopes required for notifications: classic needs `notifications` (or `repo`), fine-grained needs **Notifications: read-only** on the target repos. Like Slack's `slack.demand.list`, github notifications are a demand signal that could feed a future demand-oriented MCP tool.

### 4. Run ingestion

```bash
suasor github sync            # incremental ingestion (resume from the last cursor)
suasor github sync --full     # ignore the cursor and rescan everything
suasor github sync --json     # print counts + cursor as JSON
```

Example output:

```text
github sync: 12 observed, 3 updated, 5 unchanged.
```

- **identity**: a source's `external_id` is `gh:<owner>/<repo>:issue:<number>` / `gh:<owner>/<repo>:pull_request:<number>`. Because notifications are per-token they have no repo prefix and are `gh:notification:<thread-id>` (all unique across sources)
- **source_type**: `github_issue` / `github_pull_request` / `github_notification`
- **delta detection** (FR-ING-3): the issues `since` cursor (delta API) fetches only updated items, and the body fingerprint skips unchanged ones. notifications have their **own `since` cursor on the token axis** that advances independently of the issues axis (the cursor is stored as a `{ issues, notifications }` JSON map; a legacy bare-string cursor is interpreted for backward compatibility as the issues floor). Re-runs are idempotent (unchanged sources produce no update event)

### 5. Search

Ingested bodies (title + body) become searchable via FTS immediately:

```bash
suasor search rocket
```

Via MCP the same search is available through the `search` read tool ([retrieval](../design/retrieval.md)). Enabling an embedding backend embeds bodies at ingestion time so you can also use `recall.search` semantic search (for cross-language and vocabulary-mismatch cases) ([embedding setup](embedding.md)).

Across all connectors, the behavior of ingestion, search, delta detection, and the secret path (env override > keychain) is identical. Below we note only each connector's specific token / config slice. Tokens are **never written to config.toml** (env override or keychain).

## per-resource error isolation (github / google / box / ms-graph / notion / jira)

A connector that scans multiple resources (github=repo / google=resource family / box=folder / ms-graph=resource family / notion=database + pages / jira=project) in one pass ensures that **one resource's failure does not drag down the ingestion of the others** (generalizing the per-workspace error isolation from [ADR-0014](../adr/0014-slack-multi-workspace.md) beyond Slack, [#193](https://github.com/ozzy-labs/suasor/issues/193)). Previously a single repo's `403` would also stop ingestion of the other repos in the same pass.

- **Skip a failed resource and continue**: a resource that fails mid-fetch is aggregated into a warning and does not stop ingestion of the remaining resources.
- **Aggregate into a single warning**: in the form `github: 2 repo OK, 1 failed (cursor preserved) — owner/x (403)`, making explicit which resource failed and why (the kind per connector is `repo` (github) / `resource` (google / ms-graph) / `folder` (box) / `project` (jira) / `database` (notion)).
- **No cursor reset**: a failed resource's prior cursor is preserved (not reset). github **does not advance the shared `since` cursor to a failed repo's latest `updated_at`**, so a failed repo's gap is not silently skipped next time (only successful repos advance the shared floor). google / box / ms-graph are fingerprint-based (cursor `null`) so there is no advancement at all, and they recover on the next rescan.
- **Throw only when all resources fail**: a pass where every resource failed exits as an **error** rather than a "silent empty success" (re-throwing the last error).
- **Exit code + summary for partial failure**: a partial failure where only some resources failed sets `partialFailure`, prints a single **per-resource summary line** at the end of sync (e.g. `repos: owner/a=ok, owner/b=failed (cursor preserved)`), and exits with **exit 1** so cron / CI can gate on the exit code (records for the resources that were ingested are retained, [ADR-0027](../adr/0027-bulk-sync-orchestration.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)). Same semantics as Slack's per-workspace isolation.

Connectors that carry a token (github / ms-graph / google / box / notion / jira) can store to the keychain and verify with the generic `auth set` / `auth test` verbs (Issue #85). `suasor <connector> auth set` (save the primary secret to the keychain via stdin / `--token`) / `suasor <connector> auth test` (verify credential validity with a read-only round-trip and print identity, granted scopes, and readiness). The primary secret each connector reads is github=`token` / ms-graph=`clientSecret` / google=`refreshToken` / box=`token` / notion=`token` / jira=`token`. Running it on a TTY without `--token` prints a `Paste the <secret> and press Enter` prompt (single-line input with echo suppressed) to stderr (silent when piped, [Issue #383](https://github.com/ozzy-labs/suasor/issues/383)). Slack keeps its own `slack auth set/test` with scope readiness and multi-workspace support (below).

## Slack

Ingests channel messages (`@slack/web-api`).

### Create a Slack App and issue a token (3 steps)

Slack tokens are **issued by installing a Slack App**. Missing a required scope easily makes `sync` silently ingest zero, so it is safest to build from the bundled **App manifest** (the manifest includes every required scope).

Bundled manifest: [`slack-app-manifest.yaml`](slack-app-manifest.yaml) (the scope SSOT is `FEATURE_SCOPES` in [`src/connectors/slack/scopes.ts`](../../src/connectors/slack/scopes.ts); drift is verified by `tests/connectors/slack/manifest.test.ts` = adding a feature scope to scopes.ts fails the test until the manifest is updated. No second SSOT).

1. **Create the App by pasting the manifest** — go to [api.slack.com/apps](https://api.slack.com/apps) → "Create New App" → "From an app manifest", pick the target workspace, paste the contents of [`slack-app-manifest.yaml`](slack-app-manifest.yaml) to create it, then approve via "Install to Workspace".
2. **Copy the Bot Token** — on the App's "OAuth & Permissions" page, copy the **Bot User OAuth Token** (`xoxb-…`). If you also use the engagement axis (`search:read`, User Token only), copy the **User OAuth Token** (`xoxp-…`) as well (shown only if you kept `oauth_config.scopes.user` in the manifest).
3. **Save with `suasor slack auth set`** — save the copied token to the keychain and verify connectivity:

```bash
suasor slack auth set    # save the token to the keychain via stdin / --token
suasor slack auth test   # verify + show granted scopes + feature readiness
```

If `auth test` readiness is in the `READY` family, the scopes are complete (if `MISSING <scope>` appears, re-paste the manifest and reinstall the App). For multi-workspace (below), use `--workspace <alias>` to save and verify a token per alias.

> **The User Token is optional.** The Bot Token alone covers sync for public / private / DM / group-DM. `search:read` (User Token only) is needed only for the engagement axis of `slack conversations --sort=last_self_post` (below). If you do not need it, you can remove the whole `oauth_config.scopes.user` block from the manifest.

### token / config

- **token**: Bot Token (the `channels:history` / `groups:history` read scopes). env override `SUASOR_CONNECTOR_SLACK_TOKEN`, keychain account `connector:slack:token`
- **A missing token is an error regardless of channels**: if no workspace can resolve a token, `slack sync` exits with **exit 1** and the error `no token configured for any workspace` ([#385](https://github.com/ozzy-labs/suasor/issues/385); so a missing credential is not hidden behind a channels-unset no-op warning). If at least one workspace has a token, behavior is as before (a token-less alias is warned + skipped, [ADR-0014](../adr/0014-slack-multi-workspace.md))
- **config (single workspace / backward compatible)**:

```toml
[connectors.slack]
team = "T0123ABCD"            # id prefix (stable across renames)
channels = ["C0123ABCD"]      # target channel **id**s (names not allowed; empty = ingest nothing). Get ids with `suasor slack conversations`
since = "30d"                 # cold-start floor (optional, ADR-0016). Relative 30d / 4w / 12h or ISO date 2026-01-01. Invalid values fail-fast with ConfigError at load time (#157)
self_user_id = "U0SELF"       # your own Slack user id (optional, ADR-0012). For @mention detection in slack.demand.list
discover_new = true           # detect "newly-joined conversations not in config" during sync and warn (optional, default true, ADR-0039). Set false to disable. Does not ingest
[connectors.slack.channel_since]
C0123ABCD = "90d"             # per-channel since override (optional, #57). Unspecified channels fall back to since. Same accepted formats as since (invalid values ConfigError at load time, #157)
```

- **config (multi-workspace, [ADR-0014](../adr/0014-slack-multi-workspace.md))**: listing multiple `[connectors.slack.workspaces.<alias>]` ingests N workspaces from one install. A flat `[connectors.slack]` (above) is read for backward compatibility as the `default` alias.

```toml
[connectors.slack.workspaces.acme]
team = "T0ACME"
channels = ["C0ACME1", "C0ACME2"]
[connectors.slack.workspaces.beta]
team = "T0BETA"
channels = ["C0BETA1"]
```

  The token is per alias: `connector:slack:<alias>:token` (env override `SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN`). `suasor slack auth set/test` / `slack conversations` switch the target token with `--workspace <alias>`. `slack sync` processes all aliases with **per-workspace error isolation**: a token-less alias is warned and skipped, and an alias that fails mid-fetch is also warned but **does not stop the ingestion or cursor advancement of other aliases** (the failed alias's prior cursor is preserved = not reset). If all aliases fail, it exits with an error (#56).

- **Resolution when `--workspace` is omitted** ([#371](https://github.com/ozzy-labs/suasor/issues/371) theme 1): when `--workspace` is omitted, operational verbs (`slack auth set/test` / `conversations` / `cursor reset/backfill`) pick the target workspace from the config shape. A **flat `[connectors.slack]`** (no `workspaces`) is `default` as before (secret name `token`). If there is only a **single named workspace**, **that alias is adopted automatically** (it used to silently look at the flat `token` and become a no-op that "thought it reset that workspace"). If there are **two or more workspaces** and no `default` alias, it **errors, listing the available aliases** (`error: multiple Slack workspaces configured (acme, beta); pass --workspace <alias> to choose one.`). If a `default` alias is defined, omission falls back to it.
- **Token env override name** ([#371](https://github.com/ozzy-labs/suasor/issues/371) theme 4): when a token cannot be resolved, the error names that workspace's env override (for headless / WSL). The name is `SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN`, where non-alphanumeric characters in the alias (e.g. `-`) are normalized to `_` (e.g. `beta-eu` → `SUASOR_CONNECTOR_SLACK_BETA_EU_TOKEN`). flat/default is `SUASOR_CONNECTOR_SLACK_TOKEN`. The paste-ready config block that `slack conversations` prints also annotates each workspace section with this env override name plus a `slack auth set --workspace <alias>` hint in comments. When multi-workspace is detected it also prints a note that "this is the `[connectors.slack.workspaces.<alias>]` (multi) shape and **each workspace needs its own token**" (to prevent the accident of pasting a flat block and only noticing via `workspace 'X' skipped: no token`).
- **Discovering `self_user_id`** ([#371](https://github.com/ozzy-labs/suasor/issues/371) theme 2): `slack auth test` prints the resolved `user_id` (`U…`) and guides you to paste it as `self_user_id = "U…"` into that workspace section (flat is `[connectors.slack]`, named is `[connectors.slack.workspaces.<alias>]`). Without `self_user_id`, `slack.demand.list` **cannot detect @mentions and silently degrades to DM-only** ([ADR-0012](../adr/0012-slack-demand-digest.md)), so set one per alias for multi-workspace.
- **Workspace identification in output** ([#371](https://github.com/ozzy-labs/suasor/issues/371) theme 3): `slack status` annotates each alias with its team id + resolved workspace name (from the `slack_teams` projection, [ADR-0037](../adr/0037-slack-name-enrichment.md)) (e.g. `[acme]  team T0ACME (Acme Inc)`). `cursor reset/backfill` also shows the target workspace's team on stderr. If the name is unresolved it falls back to the team id.

  **Per-ws summary + exit code** ([ADR-0014](../adr/0014-slack-multi-workspace.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)): a single **per-workspace summary line** is printed at the end of sync (e.g. `slack: workspaces: acme=ok, beta=failed (cursor preserved), gamma=skipped (no token)`). Furthermore, even a **partial failure where only some ws failed** exits with **exit 1** (records for the ws that were ingested are retained as-is). This lets cron / CI gate on the exit code to detect partial failures (previously only "exit 1 when all ws failed", so partial failures were hidden in exit 0). Via `suasor sync` (all connectors at once, [ADR-0027](../adr/0027-bulk-sync-orchestration.md)) too, a Slack partial failure is counted as a connector failure and the whole run exits 1. The no-cursor-reset for failed ws (above) is preserved.

  **Shared-channel deduplication** ([ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) / [#363](https://github.com/ozzy-labs/suasor/issues/363)): in Enterprise Grid a single channel can be **shared across multiple workspaces** (cross-department, external BP collaboration, etc.). Because a shared channel has one globally unique channel ID across the whole Grid, even if you list the same channel ID in multiple aliases' `channels`, sync **ingests it only once, under a single owner workspace** (skipping it in the remaining aliases). The owner is the **lexicographically smallest alias name** among those that list the channel (a deterministic rule that does not depend on TOML parser order; stable across re-syncs). When sharing is detected it aggregates into a single warn showing the owner and the skipped targets (e.g. `channel C123 shared across [bp, employees] → ingesting under 'bp'`). Only the owner holds the cursor. The externalId format is unchanged, so **single-workspace setups and non-shared channels behave identically**. The assumption "channel IDs are globally unique" holds within one Grid; Slack Connect (external-org sharing) is out of scope ([ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) §6).

  **Clean up existing duplicate sources** (for environments that already double-ingested **before** introducing [ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) Layer 1): the dedup above ingests a shared channel under the owner only in **future syncs**, but an environment that already double-ingested before Layer 1 still has **past duplicate message sources on the non-owner alias**. Non-owner duplicates can be identified by the externalId prefix `slack:<non-owner-team>:<shared-channel>:*` (leave the owner's sources as-is). Cleanup steps:

  1. **Remove the channel from the non-owner alias's config** — delete the shared channel id from `channels` in `[connectors.slack.workspaces.<non-owner-alias>]` (henceforth only the owner ingests it). The owner is the **lexicographically smallest alias name** among the aliases that list the channel. `suasor doctor`'s shared-channel warn (below) names the owner and the skipped targets, so you can tell at a glance which alias to remove from without running a sync.
  2. **Rebuild the projection** — rebuild the projection via event replay with `suasor projections rebuild`. This converges the last-write-wins flip of `slack_channels.team_id` ([ADR-0037](../adr/0037-slack-name-enrichment.md)) onto the owner ([ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) §4).
  3. **Purge the remaining non-owner duplicate sources** — even after rebuilding the projection, the event log still contains the previously-ingested non-owner duplicate message sources (rebuild only replays events and does not delete past sources). Use `suasor source list --type slack_message` to find externalIds with the `slack:<non-owner-team>:<shared-channel>:*` prefix, and `suasor source forget <externalId>` ([ADR-0026](../adr/0026-source-forgetting.md), destructive, apply with `--yes`) to redact the body and remove it from the projection / FTS / vector.

  After cleanup the shared channel converges to a single owner lineage, resolving duplicate hits in `slack.demand.list` / `search` / `brief`. To identify cleanup targets, use `suasor doctor`'s shared-channel warn ([ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) Layer 3): without running a sync it detects the same channel id listed in multiple aliases and shows the owner (lexicographically smallest alias) and the skipped targets.

  **Warn for channels you have not joined** ([ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) / [#165](https://github.com/ozzy-labs/suasor/issues/165)): `READY` from `auth test` is a judgement of **scope only**; reachability of a channel (membership) is a separate layer. For a channel the bot has not joined (has not been `/invite`d to), Slack returns `not_in_channel` at sync time and the channel stays **empty with no error** = it tends to be silent. So sync **aggregates `not_in_channel`** (and the channel-level unreachable errors `channel_not_found` / `is_archived`) **into a single warn per workspace**, making explicit which channels are unreachable (`workspace '<alias>': N channel(s) unreachable — C123 (not_in_channel), …`). This is a **per-channel** skip: it does not stop ingestion of other reachable channels in the same workspace, and preserves the prior cursor of an unreachable channel (does not reset). Workspace-wide errors such as `ratelimited` are handled by per-workspace isolation (above) as before.

- **identity**: `slack:<team>:<channel>:<ts>` (unique across workspaces thanks to the team prefix) / **source_type**: `slack_message`
- **thread replies** ([ADR-0015](../adr/0015-slack-thread-replies.md)): for each message in `conversations.history` whose parent has `reply_count > 0`, it follows `conversations.replies` and ingests the replies too (messages without replies are not called = N+1 suppression). Replies use the same identity / `threadTs` meta, and the per-channel cursor shares the maximum `ts` of history and replies. Note: a new reply to a thread whose parent is older than the cursor/floor is out of scope (by design there is no per-thread cursor)
- **delta detection**: the `oldest` cursor of `conversations.history`. The cursor is a JSON map holding the latest `ts` per **alias → channel** (`{ "<alias>": { "<channel>": "<ts>" } }`), and each channel resumes from its own high-water mark ([ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) / [ADR-0014](../adr/0014-slack-multi-workspace.md)). A legacy flat map (`{ "<channel>": "<ts>" }`) is interpreted for backward compatibility as the `default` alias, and a single `ts` as the floor for the first run after upgrade
- **onboarding** ([ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)):

```bash
suasor slack auth set                  # save the token to the keychain (stdin / --token)
suasor slack auth test                 # verify + granted scopes + feature readiness
suasor slack conversations             # enumerate visible conversations and print a [connectors.slack] block
suasor slack conversations --new       # show only newly-joined conversations not in config (below)
# → paste the output block into config.toml and enable it, then
suasor slack sync                      # (= <connector> sync) ingest
```

  `auth test` prints, per scope, the readiness of `public channel sync` / `private channel sync` / `DM sync` / `group-DM (mpim) sync` / `engagement axis` (`READY` / `READY (degraded: +users:read …)` / `MISSING <scope>` / `N/A (User Token only)`). READY only guarantees scope; an unjoined channel stays `not_in_channel` (membership is a separate layer). Unjoined channels are made explicit by the aggregated warn at sync time (the "Warn for channels you have not joined" above). To see reachability before configuring, use the membership mark of `slack conversations` (below)

  `conversations` output starts with a `Joined  ID / Name` label row and makes explicit that **column 1 is the membership mark and column 2 (id) is the value to paste into `channels`** ([#158](https://github.com/ozzy-labs/suasor/issues/158) / [#165](https://github.com/ozzy-labs/suasor/issues/165)). The **membership mark** `✓` means the token's principal is a member of that conversation (= reachable by sync); a channel with no mark is unjoined = it comes up empty with `not_in_channel` at sync time (ADR-0011; derived from Slack's `is_member`; DMs / group-DMs are always members. If there is at least one unjoined channel, a supplementary note is printed to stderr. `--json` includes `isMember` for each conversation). It is **sorted a-z within a type**, and **for DMs the counterpart's display name is resolved via `users.info`** and printed as `dm:<name>` (`users:read` required; falls back to `dm:<userId>` when unresolved). The `channels` in the emitted `[connectors.slack]` block is also the id (the `#` comment is only the display-name label). Sequential `users.info` resolution for DMs and `search.messages` pagination for `--sort=last_self_post` tend to be long, so **progress (processed count) is printed to stderr** (the same `createProgress` as `sync`, TTY only, disabled with `--no-progress`, #84).

  > **channels are ids (names not allowed).** In `channels` specify conversation **id**s (`C…` public / `G…` private/group-DM / `D…` DM). Pasting a channel **name** like `#general` means `conversations.history` cannot look up the id and results in **silent zero ingestion**, so at `sync` time a value not starting with `C/D/G` produces a warning (not hard-enforced = it does not lock out future id prefixes, [ADR-0007](../adr/0007-connector-contract.md) / [#158](https://github.com/ozzy-labs/suasor/issues/158)). Get ids with `suasor slack conversations`.

#### How to find new conversations (`--new`, [ADR-0039](../adr/0039-conversation-discovery-drift.md))

  `channels` is an **explicit list** (= data minimization and explicit control of the ingest scope, [ADR-0003](../adr/0003-local-first-and-content-minimization.md) / [ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)), so joining a new channel after initial setup is **not ingested automatically**. Missing it means "you joined but it never enters suasor" = the completeness of demand / search / brief drops. `suasor slack conversations --new` shows **only this drift (the difference between conversations visible to the token and `channels` in config)** (no need to eyeball the full list):

- **New** (`isMember` but not in config) is printed as a paste-ready `[connectors.slack]` fragment (reusing `renderConfigBlock`). Unjoined (no `✓`) conversations would be empty if ingested, so they are excluded from candidates.
- **Disappeared** (in config but unreachable by the token = left / archived / renamed) is surfaced with a warn on stderr (**not auto-deleted** = the ingestion decision is left to the operator).
- The default diff sweep is **public + private only** (DMs / group-DMs are noisy). You can widen it with `--types public,private,im,mpim`. A configured DM id is not misjudged as "disappeared" even when not swept.
- `--json` returns a **new shape, since it is a new flag**: `{ new: [...], removed: [...] }`. The existing full-enumeration `slack conversations --json` (`{ teamId, conversations, … }`) is **unchanged**.
- `--workspace <alias>` scopes to a single workspace (`--new` does not do the Enterprise Grid auto-enumeration).
- **Silent auto-follow is not the default** ([ADR-0039](../adr/0039-conversation-discovery-drift.md)). An append path (`--apply`) is to be decided in a follow-up PR (Layer 3).

##### Automatic detection during sync + `doctor` drift check ([ADR-0039](../adr/0039-conversation-discovery-drift.md) Layer 2)

  To remove the need to "run `--new` by hand every time", after resolving each workspace's token `slack sync` lightly sweeps `users.conversations` (public + private only) and, if there are **member conversations** outside config, prints a **single-line aggregated warn** (``N new conversation(s) visible but not in config — run `suasor slack conversations --new` …``). It **does not ingest and the cursor is unchanged** (preserving the privacy design of explicit enumeration).

- **opt-out**: `[connectors.slack] discover_new = false` (default `true`). For multi-workspace, override per-workspace with `[connectors.slack.workspaces.<alias>] discover_new` (per-workspace value > connector value > default `true`).
- **cadence (throttling)**: it does not call on every sync but sweeps **only workspaces where 24h have passed since the last sweep**. The last sweep time + new count are held lightly in a reserved key inside the connector cursor (separate from the channel cursor; not shown in `slack status` / `cursor reset`), creating no extra projection / event.
- **Single-run toggles ([ADR-0039](../adr/0039-conversation-discovery-drift.md) §3)**: CLI flags that change behavior for that run only without editing config (common to `connector-sync`, honored by Slack only):
  - `suasor slack sync --discover` — ignore the 24h cadence (and the `discover_new = false` opt-out) and **sweep immediately**. For checking drift right after joining a new channel.
  - `suasor slack sync --no-discover` — **suppress the sweep for that run** even if config has `discover_new = true` (the cadence marker and cursor are unchanged).
  - Specifying both at once is an error (contradictory). If neither is specified, it follows config (`discover_new` + cadence) as before. On non-Slack connectors both flags are no-ops (there is no discovery concept).
- **best-effort**: even if the sweep fails, it does not stop the sync itself or cursor advancement — only a warn. Rate-limiting rides on the shared `slackFetch` ([ADR-0019](../adr/0019-slack-fetch-rate-limit-retry.md)).
- **`suasor doctor`** does not hit the network; it reads the drift marker saved by this sweep and surfaces "N new Slack conversations not added" as a **WARN** (does not change the exit code; the diagnostic is offline, [ADR-0039](../adr/0039-conversation-discovery-drift.md)). A workspace with `discover_new = false` does not show a stale marker.

- **demand signal** ([ADR-0012](../adr/0012-slack-demand-digest.md)): from ingested `slack_message`, @mentions (when `self_user_id` is set) / DMs are retrieved via MCP `slack.demand.list` as a "should-read but unprocessed" signal (derived from a query, no extra fetch). The `next-actions` / `personal-brief` skills fold it in at high priority.
- **engagement axis** ([ADR-0013](../adr/0013-slack-engagement-axis.md)): `suasor slack conversations --sort=last_self_post` orders conversations by "when you last posted". Because it uses `search.messages` (`from:me`) it is **User Token (`xoxp-`) only**, degrading to `N/A` on a Bot Token (enumerated in normal order). Values are approximate due to Slack full-text index lag. The `last_self_post` column in the table is a human-readable time (`YYYY-MM-DD HH:MM (<relative-time>)`) (`--json` keeps raw ts, #84).
- **rate-limit retry** ([ADR-0019](../adr/0019-slack-fetch-rate-limit-retry.md)): the operational / discovery / auth / search fetch paths (`users.conversations` / `users.info` / `auth.test` / `search.messages`) do not die instantly on 429 but recover by honoring `Retry-After` (or 1s/2s/4s backoff when absent, 3 attempts by default) (shared `slackFetch`). The sync hot path (`conversations.history` / `replies`) delegates to `@slack/web-api`'s default retry (not held twice).
- **date floor / recovery** ([ADR-0016](../adr/0016-slack-sync-date-floor.md)): `since` (settable per-workspace) sets a cold-start floor. The floor applies only to channels with no saved cursor; a resumed channel prefers its cursor. The `since` / `channel_since` values are **validated as parseable at config load time**, and a value that parses as neither relative (`30d` / `4w` / `12h`) nor an ISO date (`2026-01-01`) (e.g. `"3 weeks"`) fails fast with `ConfigError` (preventing a silent degradation to "no floor" that would trigger a full-history backfill, [ADR-0007](../adr/0007-connector-contract.md) / #157). Operational verbs:
  - `suasor slack status [--json]` — show the stored cursor (resume ts per workspace / channel). The resume ts is printed as a human-readable time (`YYYY-MM-DD HH:MM (<relative-time>)`) so you can tell at a glance "which channel was ingested up to when" (`--json` keeps raw ts, #84)
  - `suasor slack cursor reset --channel C1,C2 | --all [--workspace A] [--yes]` — clear the cursor and re-fetch from the `since` floor on the next sync (without `--yes` it is preview only)
  - `suasor slack cursor backfill --channel C1 --since 180d [--workspace A] [--yes]` — lower the specified channel's cursor to the `--since` floor (older than the current position) and re-fetch the un-fetched window on the next sync (for backfilling older than the floor, #57)
  - `since` can also be overridden per-channel (`[connectors.slack.channel_since]`, #57)
  - `suasor slack resolve-names [--workspace A] [--force] [--json]` — scan already-ingested `slack_message` sources and retroactively resolve channel / user ids whose names are still unresolved via `conversations.info` / `users.info` to enrich the projection (because forward sync only names newly-ingested items, [ADR-0037](../adr/0037-slack-name-enrichment.md) §11). Idempotent (ids that already have a name are skipped; re-resolve with `--force`). Ids with insufficient scope / API errors are skipped and it continues, printing a summary of resolved / skipped / degraded counts. This lets `slack status` / `cursor` / `slack.demand.list` present conversations by human-readable name rather than id

## Microsoft Graph (`ms-graph`)

Ingests Microsoft 365 (Outlook mail / Calendar / OneDrive / Teams) (`@microsoft/microsoft-graph-client` + `@azure/msal-node`, app-only client-credential flow).

- **token**: the App registration's client secret. env override `SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET`, keychain account `connector:ms-graph:clientSecret`
- **config**:

```toml
[connectors.ms-graph]
tenantId = "<directory-id>"
clientId = "<app-client-id>"
user = "user@contoso.com"               # target mailbox / drive
resources = ["mail", "calendar"]        # mail | calendar | files | teams
```

- **identity**: `msgraph:<resource>:<id>` / **source_type**: `ms365_mail` / `ms365_calendar` / `ms365_file` / `ms365_teams_message`
- **delta detection**: paginate the collection with `@odata.nextLink` and skip unchanged items by body fingerprint. `files` (OneDrive) uses the DriveItem content hash (`file.hashes.quickXorHash`, or sha256/sha1 if absent) as the fingerprint, so it **also detects content changes** without a rename and re-extracts ([ADR-0024](../adr/0024-document-extraction-sidecar.md) §6). When the hash is absent it falls back to the SHA-256 of the body (file name)
- **Body extraction (OneDrive `files`)** ([ADR-0024](../adr/0024-document-extraction-sidecar.md) / [ADR-0034](../adr/0034-api-connector-extraction.md), #243): with the `[extraction]` sidecar enabled, Office/PDF (`.docx`/`.xlsx`/`.pptx`/`.pdf`) in the `files` resource are **read-only** lazy-fetched via the Graph API (`GET /users/{user}/drive/items/{id}/content`) and replaced with the extracted text. It goes through the same shared base (the extraction stage in `src/connectors/sync.ts`) as `local` / `box`. mail / calendar / teams ingest their text body as-is and are not extraction targets. Other files are **name-only**. See the [extraction guide](extraction.md) for details and degrade behavior
- **size guard**: if the DriveItem `size` exceeds `[extraction].maxBytes` it is not fetched and is name-only. fetch / extraction failure and unsupported also degrade to name-only (ingestion itself succeeds)
- **onboarding** (Issue #85): `suasor ms-graph auth set` (save the client secret to the keychain) / `suasor ms-graph auth test` (verify the client secret + tenantId/clientId connectivity via a client-credential token exchange and print granted scope). `auth test` requires `tenantId` / `clientId` in config.
- **feature readiness** (Issue #194): `auth test` prints a `features:` line per `resources` in config (same format as Slack). client-credential returns `.default`, and the actual application permissions (Mail.Read / Calendars.Read / Files.Read.All / Channel / Chat.Read.All) are resolved server-side and not enumerated in the token `scope`, so each line is `N/A (scopes not enumerated)` (check the actual permissions on the Azure app registration side). If `resources` is unset, only a single line `ingestion: N/A (no resources configured)`:

  ```text
  ok: ms-graph credential for app <client-id> @ tenant <tenant-id>
  scopes: https://graph.microsoft.com/.default
  features:
    mail read (Mail.Read): N/A (scopes not enumerated)
    calendar read (Calendars.Read): N/A (scopes not enumerated)
  ```

## Google

Ingests Google Workspace (Drive / Gmail / Calendar) (`googleapis`, OAuth2 refresh token).

- **token**: OAuth refresh token (read scope for the target APIs). env override `SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN`, keychain account `connector:google:refreshToken`
- **config**:

```toml
[connectors.google]
clientId = "<oauth-client-id>"
calendarId = "primary"                   # target for calendar events
resources = ["drive", "gmail", "calendar"]  # drive | gmail | calendar
```

- **identity**: `google:<resource>:<id>` / **source_type**: `google_drive` / `gmail_message` / `google_calendar`
- **delta detection**: paginate with `nextPageToken` and skip unchanged items by body fingerprint. Drive files use a **content fingerprint** (`md5Checksum` for binary, and the monotonically increasing `version` for Google-native files since they have no md5), so content changes without a rename are detected and re-ingested / re-extracted. Gmail / Calendar stay on the body SHA-256 fingerprint
- **onboarding** (Issue #85): `suasor google auth set` (save the refresh token to the keychain) / `suasor google auth test` (verify connectivity via a refresh→access token exchange and print granted scope). `auth test` requires `clientId` in config, and for an installed/web client it also uses `connector:google:clientSecret` if you place it in the keychain (not needed for a public client).
- **calendar discovery** ([ADR-0030](../adr/0030-connector-discovery-verbs.md)): hand-copying `calendarId` from the Web UI easily produces a typo that makes calendar sync **silently return 0**. Use the discovery verb that enumerates calendars visible from the token so you can paste them (the equivalent of github's `github repos`):

  ```bash
  suasor google calendars                  # enumerate visible calendars and print a [connectors.google] block
  suasor google calendars --filter team    # filter by substring match on id / summary (case-insensitive)
  suasor google calendars --json           # print items + configBlock as JSON
  ```

  After exchanging the refresh token for an access token, it enumerates `GET /calendar/v3/users/me/calendarList` (`nextPageToken` pagination) with `fetch` only (no `googleapis` dependency, import-clean, [ADR-0007](../adr/0007-connector-contract.md)) and prints calendarId / summary / timeZone / primary. It requires `clientId` in config, and an installed/web client also uses `connector:google:clientSecret` from the keychain (same shape as `auth test`). Unlike github's `repos` array, the paste-ready `[connectors.google]` block at the end of the output sets a **single** `calendarId` to the primary (or first) calendar and lists the other calendars as `# calendarId = "..."` comment lines, so you can switch the target just by swapping them. The refresh token / client secret / access token are never leaked in errors.
- **feature readiness** (Issue #194): `auth test` prints a `features:` line per `resources` in config (same format as Slack). Because Google's token response enumerates granted scope URLs, each resource's scope (`drive` / `gmail` (or `mail.google.com`) / `calendar`) is `READY` if included in the granted scopes and `MISSING <scope>` otherwise. If `resources` is unset, only a single line `ingestion: N/A (no resources configured)`:

  ```text
  ok: google credential for client <client-id>
  scopes: https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly
  features:
    Drive read: READY
    Gmail read: READY
    Calendar read: MISSING calendar
  ```

- **Body extraction** ([ADR-0024](../adr/0024-document-extraction-sidecar.md) / [ADR-0034](../adr/0034-api-connector-extraction.md), #242): with the `[extraction]` sidecar enabled, Office/PDF (`.docx`/`.xlsx`/`.pptx`/`.pdf`) on Drive are **read-only** lazy-fetched (`downloadFile`) via the Drive media endpoint, and Google-native files (Docs/Sheets/Slides) are mapped to an Office format (docx/xlsx/pptx) via the Drive **export** endpoint (`exportFile`) before being replaced with the extracted text. It goes through the same shared base (the extraction stage in `src/connectors/sync.ts`) as `local` / `box`. Gmail / Calendar and non-exportable natives (Forms, etc.) are **name-only**. size guard (if a binary's `size` exceeds `maxBytes` it is not fetched and is name-only), and name-only degrade on fetch / export / extraction failure and unsupported (ingestion itself succeeds). See the [extraction guide](extraction.md) for details

## Box

Ingests files under a folder (`box-typescript-sdk-gen`).

- **token**: Developer / OAuth access token (read scope for the target folder). env override `SUASOR_CONNECTOR_BOX_TOKEN`, keychain account `connector:box:token`
  - **Note on token expiry**: Box's **developer token expires in 1 hour** (for local verification and small syncs). For large syncs or scheduled runs, re-obtain the token with `auth set` each time it expires, or use a non-expiring **OAuth2 / JWT (server auth) token**, which is recommended.
- **config**:

```toml
[connectors.box]
folders = ["0"]                          # target folder ids (root is "0")
```

- **identity**: `box:file:<id>` / **source_type**: `box_file`
- **delta detection**: uses the `sha1` (content hash) Box returns as the fingerprint to skip unchanged files. Being a content fingerprint, it **also detects content changes without a rename** and re-ingests / re-extracts. When `sha1` is absent it falls back to the SHA-256 of the body (= file name)
- **onboarding** (Issue #85): `suasor box auth set` (save the access token to the keychain) / `suasor box auth test` (verify token validity via `GET /2.0/users/me` and print account login / name).
- **discovery** ([ADR-0030](../adr/0030-connector-discovery-verbs.md), #192): `suasor box folders [--root <id>] [--filter S] [--json]`. It enumerates `GET /2.0/folders/<id>/items` (folder entries only, marker pagination) with `fetch` only (no SDK dependency, import-clean), draws a **tree** of id / name (`--root` defaults to the Box root `"0"`, one level directly under root), and prints a paste-ready `[connectors.box]` block (`folders = [...]`, each line a `# <name>` label). Specify the starting folder with `--root`, `--filter` is a substring match on name / id, and `--json` prints `{items, configBlock}` (the token is not printed). This avoids silent 0 counts from hand-copied folder id typos ([ADR-0007](../adr/0007-connector-contract.md)).
- **feature readiness** (Issue #194): Box's `users/me` has no scope list (the live identity is the judgement itself), so `features:` is a single line `Box folder read: READY` (no scope gate; reachability of a folder is a separate layer).
- **Body extraction** ([ADR-0024](../adr/0024-document-extraction-sidecar.md) / [ADR-0034](../adr/0034-api-connector-extraction.md), #241): with the `[extraction]` sidecar enabled, Office/PDF (`.docx`/`.xlsx`/`.pptx`/`.pdf`) are **read-only** lazy-fetched (`downloadFile`) via the Box API and replaced with the extracted text. It goes through the same shared base (the extraction stage in `src/connectors/sync.ts`) as `local`. Other files are **name-only** (searchable by file name only). See the [extraction guide](extraction.md) for details and degrade behavior
- **size guard**: if the `size` Box returns exceeds `[extraction].maxBytes` it is not fetched and is name-only. fetch / extraction failure and unsupported also degrade to name-only (ingestion itself succeeds)

## Notion

Ingests a knowledge base (standalone pages, database rows). Because the Notion REST API is plain JSON, it is implemented with `fetch` only (import-clean) and no SDK.

- **token**: Notion internal integration token. env override `SUASOR_CONNECTOR_NOTION_TOKEN`, keychain account `connector:notion:token`
  - **Sharing is a prerequisite**: Notion does not use token scope; **only pages / databases the integration is shared with** are readable. You must "Connect" / "Share" the pages / DBs you want to ingest with the integration in the Notion UI (an unshared resource appears in neither discovery nor sync).
- **config**:

```toml
[connectors.notion]
databases = ["<database-id>"]            # target DB ids (one source per row)
page_depth = 10                          # max block recursion depth (default 10)
pages = true                             # also ingest standalone pages visible via search (default true)
```

- **identity**: `notion:page:<id>` (standalone page) / `notion:db:<db-id>:item:<row-id>` (DB row). A DB row's identity is db-scoped, so the same row id under two DBs does not collide / **source_type**: `notion_page` / `notion_database_item`
- **body**: the page / row title + the recursive plain text of blocks (paginate `GET /v1/blocks/{id}/children` with `start_cursor`). Depth is limited by `page_depth`, and circular references in synced blocks are avoided with a visited-id guard
- **delta detection**: since Notion has no delta API, it uses `last_edited_time` as the **content fingerprint**. If `last_edited_time` advances it re-ingests even when the body is unchanged, and if it does not change it is a no-op (cursor is `null`)
- **onboarding** (Issue #85): `suasor notion auth set` (save the integration token to the keychain) / `suasor notion auth test` (verify token validity via `GET /v1/users/me` and print the bot name / workspace name).
- **discovery** ([ADR-0030](../adr/0030-connector-discovery-verbs.md)): `suasor notion databases [--filter S] [--json]`. It enumerates `POST /v1/search` (`database` objects only, `start_cursor` pagination) with `fetch` only and prints a paste-ready `[connectors.notion]` block (`databases = [...]`, each line a `# <title>` label). `--filter` is a substring match on title / id, and `--json` prints `{items, configBlock}` (the token is not printed). This avoids silent 0 counts from hand-copied database id typos ([ADR-0007](../adr/0007-connector-contract.md)).
- **feature readiness** (Issue #194): Notion's `users/me` has no scope list (capability is determined not by token scope but by the **shared pages / DBs**), so `features:` is a single line `Notion page / database read: READY`.
- **backoff** ([#269](https://github.com/ozzy-labs/suasor/issues/269)): all fetch paths (sync / auth / discovery) go through the shared `withRetry`, and 429 / 5xx are retried with exponential backoff + jitter honoring `Retry-After`.

## Jira

Ingests issues / comments and supplies project / ticket demand signals (agile context on a separate axis from GitHub issues) to search / research / next-actions. Because the Jira REST API is plain JSON, it is implemented with `fetch` only (import-clean) and no SDK.

- **token**: an API token for Cloud, a PAT for self-hosted. env override `SUASOR_CONNECTOR_JIRA_TOKEN`, keychain account `connector:jira:token`
  - **email is config**: because Cloud HTTP Basic auth uses `email:apiToken`, `email` is held as a **non-secret config value** (only the API token goes in the keyring). For self-hosted `auth = "bearer"` (PAT), `email` is not needed.
- **config**:

```toml
[connectors.jira]
host = "example.atlassian.net"           # Jira site host (no scheme)
email = "you@example.com"                # for Cloud (basic) auth. Omit for self-hosted PAT
projects = ["PROJ"]                       # target project keys (issue + comment)
# jql = "assignee = currentUser()"       # one sweep with an explicit JQL instead of projects (optional)
# auth = "basic"                          # basic (Cloud, default) | bearer (self-hosted PAT)
```

- **identity**: `jira:<host>:<project>:<issue-key>` (issue) / `jira:<host>:<project>:<issue-key>:comment:<id>` (comment). The identity is host + project scoped, so the same issue key on a different host does not collide / **source_type**: `jira_issue` / `jira_comment`
- **body**: for an issue, `summary` + `description` (minimal ADF / HTML → text normalization). For a comment, the body text. Even if the `description` custom field is absent, it degrades to summary alone and does not throw
- **delta detection** (FR-ING-3): with JQL `project = <key> AND updated >= "<ts>" ORDER BY updated ASC`, it stores each project's latest `updated` as a **per-project cursor** (JSON `{ "<project>": "<iso-ts>" }`) and resumes from that high-water mark next time (Slack's per-channel pattern). In `jql` mode it resumes similarly with a single `__jql__` key. Pagination is `startAt` / `maxResults`
- **per-project error isolation** ([#193](https://github.com/ozzy-labs/suasor/issues/193)): one project's failure (404 / 403, etc.) is aggregated into a warn and skipped, while ingestion of other projects continues. A failed project's cursor is preserved (not reset). It throws only when all projects fail. A partial failure exits non-zero with `partialFailure` + a summary line ([ADR-0027](../adr/0027-bulk-sync-orchestration.md))
- **onboarding** (Issue #85): `suasor jira auth set` (save the API token / PAT to the keychain) / `suasor jira auth test` (verify credential validity via `GET /rest/api/3/myself` and print the account name / email).
- **discovery** ([ADR-0030](../adr/0030-connector-discovery-verbs.md)): `suasor jira projects [--filter S] [--json]`. It enumerates `GET /rest/api/3/project/search` (`startAt` pagination) with `fetch` only and prints a paste-ready `[connectors.jira]` block (`host` / `email` placeholders + `projects = [...]`, each line a `# <name>` label). `--filter` is a substring match on key / name, and `--json` prints `{items, configBlock}` (the token is not printed). This avoids silent 0 counts from hand-copied project key typos ([ADR-0007](../adr/0007-connector-contract.md)).
- **feature readiness** (Issue #194): Jira's `/myself` has no scope list (capability is determined not by token scope but by the **authenticated account's project permissions**), so `features:` is a single line `Jira issue / comment read: READY`.
- **backoff** ([#269](https://github.com/ozzy-labs/suasor/issues/269)): all fetch paths (sync / auth / discovery) go through the shared `withRetry`, and 429 / 5xx are retried with exponential backoff + jitter honoring `Retry-After`.

## Web (`web`)

Snapshots configured URLs (operator / carrier signup pages, etc.) with a headless browser and detects diffs (`playwright-core`).

- **token**: not required (public pages only; no auth path)
- **config**:

```toml
[connectors.web]
urls = ["https://operator.example.com/signup"]
browser = "chromium"                     # chromium | firefox | webkit
```

- **identity**: `web:<sha1(url)>` (stable per URL) / **source_type**: `web_page`
- **delta detection**: the fingerprint of the snapshot's extracted text. When page content changes it is detected as an update (fingerprint diff)
- **note**: `playwright-core` does not bundle browser binaries. Provide an engine on the execution host with `npx playwright install` or similar

## Local (`local`)

Recursively scans configured local directories and ingests files ([ADR-0023](../adr/0023-local-filesystem-connectors.md)). It is a generic connector that covers OS-synced Box Drive / OneDrive / Dropbox mounts or any folder **with path configuration alone**, without adding a connector per vendor. Same "local origin" pattern as `web` (which wraps a Playwright snapshot).

- **token**: not required (local FS only; no auth path)
- **config**:

```toml
[connectors.local]
roots = ["/Users/me/Library/CloudStorage/Box-Box", "/Users/me/OneDrive"]  # directories to scan
# textExtensions = [".md", ".txt", ".json", ...]  # extensions whose body is read (default: the text-family set)
# maxBytes = 1000000                               # max bytes to read as body (over = name-only)
```

- **identity**: `local:<sha1(absolute-path)>` (stable per path) / **source_type**: `local_file`
- **roots are existence-validated at load time** ([#188](https://github.com/ozzy-labs/suasor/issues/188), ADR-0007 "no silent wrong answer"): each path in `roots` is validated as "an existing, readable directory" at **config load time** (`loadConfig`'s per-connector slice validation, [#162](https://github.com/ozzy-labs/suasor/issues/162)). A typo (e.g. `/Users/me/OnDrive`) or a non-existent path fails fast with `ConfigError` — pointing at the offending `roots.<index>` — before it would be warned + skipped at sync time. Symlinks are judged at load time by whether the link target is a directory (keeping the existing policy of not following them during scanning). An empty `roots` has nothing to validate (it passes through)
- **body**: files that match `textExtensions` and are within `maxBytes` are ingested with body (= file name + content); others are ingested **name-only** (file name only) (like box, to make them searchable by name)
- **delta detection** (FR-ING-3): the `mtime:size:contentHash` fingerprint. Content edits and metadata changes are detected as updates, and unchanged files are skipped on re-sync (fingerprint-based since there is no delta API)
- **scanning**: symlinks are not followed (read-only, cycle avoidance). Unreadable directories / files are warned and skipped without stopping the whole pass
- **note (division of labor with API connectors, ADR-0023 §3)**: ingesting the same file via both `box` (API) and `local` (FS) duplicates it. Because identity is based on the entity (path / `box:file:<id>`) they become separate sources and are not merged automatically. Operate by dividing "which connector owns which range" in config

## Adding a new connector

1. Write the `Connector` implementation and factory in `src/connectors/<name>.ts` (lazy-import the SDK inside `sync`)
2. Add one line `<name>: () => import("./<name>.ts")` to `src/connectors/registry.ts`
3. Register in `SECRET_NAMES` in `src/connectors/registry.ts` the secret names the connector reads via `ctx.secret(...)` (`[]` if no auth is needed). The token-configured introspection of `suasor connectors list` references this
4. Zod-validate the `[connectors.<name>]` config slice on the connector side

The CLI `suasor <name> sync` and MCP `connector.sync` automatically become available from the registry, and it automatically appears in `suasor connectors list`.
