# Connectors

A connector is the shared implementation that ingests from a source **read-only** ([ADR-0007](../adr/0007-connector-contract.md) / [connector-contract](../design/connector-contract.md)). Ingested items are appended as events, their bodies are kept in a local projection, and they become searchable via FTS ([ADR-0002](../adr/0002-event-sourced-architecture.md) / [ADR-0003](../adr/0003-local-first-and-content-minimization.md)).

There are two ways to trigger ingestion. Both call the same sync service:

- CLI: `suasor <connector> sync`
- MCP write tool: `connector.sync` (HITL. Never runs without human approval. [mcp-surface](../design/mcp-surface.md))

## An empty (no-op) config is warned before sync

Even when a connector is **enabled** (a `[connectors.X]` section exists and is not `enabled = false`), if its ingest scope is empty (github with `repos` unset and `notifications = "off"`, box with `folders` unset, local with `roots` unset, web with `urls` unset, google / ms-graph with an **explicit** `resources = []`, notion with `databases` unset and `pages = false`, jira with `projects` unset and `jql` unset, slack with `channels` and `lists` unset), sync silently finishes with 0 observed and you cannot notice until you inspect the DB ([#187](https://github.com/ozzy-labs/suasor/issues/187)). To prevent this, sync detects an empty config before running and prints a warning to stderr (e.g. `warning: github: repos unset and notifications=off — nothing to ingest (set repos in config, or set notifications to all/repos)`).

- The same warning appears on both paths: single sync (`suasor <connector> sync`) and bulk sync (`suasor sync`, [ADR-0027](../adr/0027-bulk-sync-orchestration.md))
- It is **warning-only** and does not change the exit code **when a credential is configured** — an empty scope with a valid credential is not a failure; the run succeeds normally with `0 observed`. A **missing** credential is a different case: credential resolution now precedes the empty-scope check, so a connector with no resolvable credential fails loudly (**exit 1**) regardless of whether its scope is empty ([#404](https://github.com/ozzy-labs/suasor/issues/404), generalizing Slack's [#385](https://github.com/ozzy-labs/suasor/issues/385); see [ADR-0007](../adr/0007-connector-contract.md))

## A missing required setting is an error, not a warning

An empty *scope* still syncs (0 observed). A missing **required non-secret setting** does not: the connector cannot address its API at all. `google` needs `clientId`, `ms-graph` needs `tenantId` + `clientId` + `user` ([ADR-0051](../adr/0051-ingest-scope-defaults.md)), and `jira` needs `host`. All of them carry a schema default of `""`, so a slice with just `enabled = true` passes `loadConfig` and `validate-config` and used to fail only at sync time with the vendor's own opaque error ([ADR-0049](../adr/0049-connector-readiness-parity.md), [#478](https://github.com/ozzy-labs/suasor/issues/478)).

`suasor doctor` now reports this as a `connectors.config` **error** (so `doctor` exits 1 and cron / CI can gate on it), and sync prints the same line before running:

```text
[ERR ] connectors.config  google: required setting(s) not set: clientId (OAuth client id of the desktop / web app) — the connector cannot reach its API until they are set in [connectors.google]
```

It is a separate line from the empty-scope warning above, on purpose: the severities and the remedies differ, and a slice can legitimately have a full ingest scope and no way to authenticate.

## Multi-account ingestion (google / ms-graph / box)

Most operators' mail, calendar and files are split across a **personal** and a **work** account. `google`, `ms-graph` and `box` ingest both in one pass via `[connectors.<name>.accounts.<account>]` ([ADR-0050](../adr/0050-multi-account-connectors.md), [#441](https://github.com/ozzy-labs/suasor/issues/441), [#537](https://github.com/ozzy-labs/suasor/issues/537)):

```toml
[connectors.google]
clientId = "shared.apps.googleusercontent.com"   # inherited by every account
resources = ["gmail", "calendar"]

[connectors.google.accounts.personal]
self_addresses = ["me@personal.example"]

[connectors.google.accounts.work]
calendarIds = ["me@work.example"]                 # overrides the flat default
resources = ["gmail", "calendar", "drive"]
self_addresses = ["me@work.example"]
```

```bash
suasor google auth set --account personal   # → keychain connector:google:personal:refreshToken
suasor google auth set --account work       # → keychain connector:google:work:refreshToken
suasor google auth test                     # tests every configured account
suasor google auth test --account work      # or just one
```

- **Nothing changes for a single account.** With no `accounts` table the flat keys *are* one account, named `default`, whose keychain entry (`connector:google:refreshToken`), env override (`SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN`) and already-ingested external ids (`google:<resource>:<id>`) are untouched.
- A named account is namespaced everywhere: keychain `connector:google:work:refreshToken`, env `SUASOR_CONNECTOR_GOOGLE_WORK_REFRESHTOKEN`, external id `google:work:<resource>:<id>`. The id prefix is **required for correctness** — Gmail message ids are unique only within a mailbox, and one meeting carries the same Calendar event id in every attendee's calendar, so without it two accounts would fight over a single source row.
- Account names allow letters, digits, `_` and `-`. Two names that normalize to the same env override (`work-a` and `work_a`) are **rejected at load**.
- Flat keys are inherited by every account that does not override them — one OAuth `clientId` for N accounts is the common case.

### Adding an account to an existing single-account config

Once an `accounts` table exists, the flat keys become **inherited defaults only** and are no longer an ingested account of their own. So if you are adding a second account to a config that was already syncing, declare the first one too:

```toml
[connectors.google]
clientId = "shared.apps.googleusercontent.com"

[connectors.google.accounts.default]   # empty table: inherits everything above,
                                       # keeps the existing keychain entry and external ids
[connectors.google.accounts.work]
calendarIds = ["me@work.example"]
```

If you forget, `suasor doctor` says so — and says it at the confidence the evidence supports:

```text
[WARN] connectors.accounts  google: a credential is stored for the unnamed default account, but the flat
                            [connectors.google] keys are inherited defaults for 'work', not an ingested
                            account of their own, so it is no longer synced — add
                            [connectors.google.accounts.default] …
```

That is a `warn` because a stored default-account credential is evidence the account really existed. With no such credential the same situation is reported as `info`: "was ingesting" and "never was" are indistinguishable from config alone, and doctor does not guess.

**Renaming an account changes identity.** The account name is part of the external id, so a rename re-ingests that account's sources under new ids and leaves the old ones behind (clean them up with `suasor source list` → `suasor source forget` if you want them gone).

### What is per account

- **credential** — each account resolves its own secret. `doctor`, `connectors list` and `config show` report presence **per account**, so one stored token can no longer make the whole connector look configured.
- **error isolation** — one account's revoked token or misconfigured tenant does not stop the others. A tokenless account is a **warned skip**; a failing one is isolated. The pass throws only when *every* account failed.
- **exit code** — a skipped or failed account makes the run a partial failure (**exit 1**), so cron / CI can gate on "half the mail is not syncing". An account with `resources = []` is a plain no-op and keeps exit 0.
- **`auth test`** — scope readiness and the reachability probe run per account, under an `account: <name>` heading. With `--account` omitted every account is tested and a failure in one does not stop the rest.
- **`self_addresses`** — **unioned** across accounts. "Me" is one person with two mailboxes, so a thread to your work address is your demand whichever account ingested it.

```text
warning: google (account 'work'): required setting(s) not set: clientId (…) — the connector cannot
         reach its API until they are set in [connectors.google.accounts.work]
```

`box` works the same way ([#537](https://github.com/ozzy-labs/suasor/issues/537)) — see [Box](#box) for its own keys. It is the same criterion: the root folder of **every** Box account is id `0`, so `folders = ["0"]` cannot say whose root it means until the account is named.

## Drift: what the credential can see that config does not list

After the initial setup, new repositories / databases / projects / folders appear over time. Because Suasor only ingests what you **explicitly enumerate** (a deliberate data-minimization choice, [ADR-0039](../adr/0039-conversation-discovery-drift.md)), anything new is simply never ingested — and re-running the full discovery verb means eyeballing the whole list again to spot it.

`--new` shows only the difference ([ADR-0049](../adr/0049-connector-readiness-parity.md)):

```bash
suasor github repos --new       # visible to the token but missing from [connectors.github].repos
suasor notion databases --new
suasor jira projects --new
suasor box folders --new
suasor google calendars --new
```

- It prints the new ids plus a paste-ready fragment to **merge into** the existing list, and — on an unnarrowed run — the configured ids that are no longer visible (renamed, deleted, or no longer permitted; they sync nothing).
- **Nothing is ingested and nothing is written to config.** Explicit enumeration stays the model; `--new` only removes the eyeballing step.
- With `--filter` / `--root` the "no longer visible" half is **not computed** and says so: a narrowed view cannot tell "gone" from "out of view".
- `google calendars --new` joined this list with [ADR-0051](../adr/0051-ingest-scope-defaults.md): it was previously refused because a single `calendarId` gave no configured *set* to diff, and `calendarIds` is a set.
- Unlike Slack, non-Slack connectors do **not** sweep for drift during sync and do not surface it in `doctor`; you see it when you run `--new`. That gap is intentional — see [ADR-0049](../adr/0049-connector-readiness-parity.md) 決定 3 for the cost reasoning.

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

- For a discovery-capable connector where the **token can be resolved** (keychain / env override) → it runs discovery and appends a block containing the discovered ids (`--json` reports `configSource` as `"discovery"` and a count in `discovered`). The appended array is the ingest set, so review it and delete what you do not want — for **google** this changed with [ADR-0051](../adr/0051-ingest-scope-defaults.md): `calendarIds` now lists every visible calendar (auto-subscribed holiday / birthday calendars included), where the old singular `calendarId` could only ever select the primary one
- Even for a discovery-capable connector, when the **token is missing / the probe fails** → it falls back to appending a minimal template slice (required keys as comment stubs) and prints the reason to stderr (`configSource` is `"template"`). You can run `suasor <connector> <verb>` by hand later and swap it in
- **Connectors without discovery** (ms-graph / web / local) → as before, a template slice with comment stubs is appended (`configSource` is `"template"`)
- **Slack** has its own bridge (below), not the generic discovery table
- If a slice already exists, discovery is not run and it is preserved non-destructively (`configSource` is `"skipped"`)

```bash
# pass the token via env override, discover github repos, and paste into config (headless)
SUASOR_CONNECTOR_GITHUB_TOKEN=ghp_xxx suasor onboard --connector github --skip-auth --json
```

### Slack onboarding bridge ([ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) / [ADR-0042](../adr/0042-slack-workspace-less-connector.md) / #384)

Slack keeps its own operational verbs (`slack auth set` / `auth test` / `conversations`) rather than the generic `auth set` / discovery table, so `suasor onboard --connector slack` **bridges that flow inline** (calling the same probes as functions, not shelling out to the CLI):

```bash
suasor onboard --connector slack   # paste the token(s) → auth test → channels → first sync
```

1. **Token(s)** → read (echo-suppressed; comma-separated for multiple) and stored as the pool secret (`connector:slack:tokens`, replace-all); with `--skip-auth` it comes from `SUASOR_CONNECTOR_SLACK_TOKENS` / the binary instead
2. **`auth test`** → the same probe as `slack auth test`, printing the granted scopes + per-feature readiness
3. **Channels** → the `slack conversations` listing leaf enumerates the **joined** public / private channels the token can see and appends a `[connectors.slack]` block carrying their ids (non-destructive). Unjoined channels (would be empty until the bot joins) and DMs / group-DMs are left for you to add by hand; if the probe fails, a placeholder slice is written and the reason printed to stderr
4. **First sync** picks up the appended slice

- **A legacy ADR-0014 multi-workspace config is not bridged.** If your config still uses `[connectors.slack.workspaces.<alias>]`, the wizard points you at the ADR-0042 migration checklist and leaves the config untouched (sync fails loudly on the legacy shape)
- This bridge is **not** registered in the generic discovery table (it would duplicate `slack conversations`), so it stays an onboard-only special case

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
suasor github repos --new              # only what is visible but missing from config (drift, ADR-0049)
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

When `repos` is empty and `notifications = "off"`, nothing is ingested. A token is still required: credential resolution precedes the empty-scope check, so a github connector with no resolvable token exits 1 rather than silently succeeding ([#404](https://github.com/ozzy-labs/suasor/issues/404); [ADR-0007](../adr/0007-connector-contract.md)).

#### notifications (per-token notification stream)

Enabling `notifications` ingests `GET /notifications` (a personal stream of mentions / review requests / assigns addressed to you) (Issue #93). This is a **per-token, not per-repo** stream, with a cursor on a separate axis from the `repos` allowlist. It is read-only (it only reads the thread list and never marks anything read).

- `off` (default): not ingested (keeps the existing issue / PR-only behavior)
- `all`: ingest notifications from all notified repos (including repos not in `repos`)
- `repos`: ingest only notifications from repos in the `repos` allowlist (the cursor advances even for filtered-out threads, preventing a re-flood next time)

`notifications = "all"` works on its own even when `repos` is empty (ingesting only the token's notification stream). PAT scopes required for notifications: classic needs `notifications` (or `repo`), fine-grained needs **Notifications: read-only** on the target repos. Alongside Slack @mentions / DMs, demand-worthy github notifications (reason = `review_requested` / `mention` / `team_mention` / `assign` / `author`) surface via the connector-neutral `demand.list` / `priority.list` MCP tools ([ADR-0041](../adr/0041-neutral-demand-priority-substrate.md)).

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

Via MCP the same search is available through the `search` read tool ([retrieval](../design/retrieval.md)). Enabling an embedding backend embeds bodies at ingestion time so you can also use 意味検索 semantic search (for cross-language and vocabulary-mismatch cases) ([embedding setup](embedding.md)).

Across all connectors, the behavior of ingestion, search, delta detection, and the secret path (env override > keychain) is identical. Below we note only each connector's specific token / config slice. Tokens are **never written to config.toml** (env override or keychain).

## per-resource error isolation (github / google / box / ms-graph / notion / jira)

A connector that scans multiple resources (github=repo / google=resource family / box=folder / ms-graph=resource family / notion=database + pages / jira=project) in one pass ensures that **one resource's failure does not drag down the ingestion of the others** (generalizing the error-isolation invariant recorded in [ADR-0014](../adr/0014-slack-multi-workspace.md) #193節 — which survives ADR-0042 as Slack's per-token isolation — beyond Slack, [#193](https://github.com/ozzy-labs/suasor/issues/193)). Previously a single repo's `403` would also stop ingestion of the other repos in the same pass.

- **Skip a failed resource and continue**: a resource that fails mid-fetch is aggregated into a warning and does not stop ingestion of the remaining resources.
- **Aggregate into a single warning**: in the form `github: 2 repo OK, 1 failed (cursor preserved) — owner/x (403)`, making explicit which resource failed and why (the kind per connector is `repo` (github) / `resource` (google / ms-graph) / `folder` (box) / `project` (jira) / `database` (notion)).
- **No cursor reset**: a failed resource's prior cursor is preserved (not reset). github **does not advance the shared `since` cursor to a failed repo's latest `updated_at`**, so a failed repo's gap is not silently skipped next time (only successful repos advance the shared floor). google / box / ms-graph are fingerprint-based (cursor `null`) so there is no advancement at all, and they recover on the next rescan.
- **Throw only when all resources fail**: a pass where every resource failed exits as an **error** rather than a "silent empty success" (re-throwing the last error).
- **Exit code + summary for partial failure**: a partial failure where only some resources failed sets `partialFailure`, prints a single **per-resource summary line** at the end of sync (e.g. `repos: owner/a=ok, owner/b=failed (cursor preserved)`), and exits with **exit 1** so cron / CI can gate on the exit code (records for the resources that were ingested are retained, [ADR-0027](../adr/0027-bulk-sync-orchestration.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)). Same semantics as Slack's per-token isolation (ADR-0042).

Connectors that carry a token (github / ms-graph / google / box / notion / jira) can store to the keychain and verify with the generic `auth set` / `auth test` verbs (Issue #85). `suasor <connector> auth set` (save the primary secret to the keychain via stdin / `--token`) / `suasor <connector> auth test` (verify credential validity with a read-only round-trip and print identity, granted scopes, and readiness). The primary secret each connector reads is github=`token` / ms-graph=`clientSecret` / google=`refreshToken` / box=`token` / notion=`token` / jira=`token`. Running it on a TTY without `--token` prints a `Paste the <secret> and press Enter` prompt (single-line input with echo suppressed) to stderr (silent when piped, [Issue #383](https://github.com/ozzy-labs/suasor/issues/383)). Slack keeps its own `slack auth set/test` with scope readiness and token-pool support (below, ADR-0042).

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

If `auth test` readiness is in the `READY` family, the scopes are complete (if `MISSING <scope>` appears, re-paste the manifest and reinstall the App). For multiple workspaces, install the App in each workspace (or use one org-level/org-wide-app token on Enterprise Grid) and store every token as **one pool** — `suasor slack auth set --token xoxb-a…,xoxb-b…` (comma-separated; the pool is replaced as a whole, [ADR-0042](../adr/0042-slack-workspace-less-connector.md)).

> **The User Token is optional.** The Bot Token alone covers sync for public / private / DM / group-DM. `search:read` (User Token only) is needed only for the engagement axis of `slack conversations --sort=last_self_post` (below). If you do not need it, you can remove the whole `oauth_config.scopes.user` block from the manifest.

### token / config

- **token pool** ([ADR-0042](../adr/0042-slack-workspace-less-connector.md)): all tokens live in **one unnamed pool** — keychain account `connector:slack:tokens`, env override `SUASOR_CONNECTOR_SLACK_TOKENS` (newline/comma separated). Writes are **replace-all** (`suasor slack auth set` replaces the whole pool), so a dead token never lingers. One org-level (org-wide app) token can cover a whole Enterprise Grid; otherwise add one workspace token per workspace. There is no per-workspace alias, secret, or `--workspace` flag anywhere.
- **A missing pool is an error regardless of channels**: if the pool secret resolves to nothing, `slack sync` exits with **exit 1** and the error `no token pool configured` ([#385](https://github.com/ozzy-labs/suasor/issues/385); a missing credential is not hidden behind a channels-unset no-op warning). A **dead token inside the pool** (failing `auth.test`) is excluded with a warn naming it (`token #N is dead … replace the pool`) while the rest keep syncing; only an all-dead pool errors.
- **config (flat, workspace-less)**:

```toml
[connectors.slack]
channels = ["C0123ABCD"]      # target channel **id**s (names not allowed; empty = ingest nothing). Get ids with `suasor slack conversations`. Channel ids are globally unique — no workspace grouping needed
since = "30d"                 # cold-start floor (optional, ADR-0016). Relative 30d / 4w / 12h or ISO date 2026-01-01. Invalid values fail-fast with ConfigError at load time (#157)
self_user_ids = ["U0SELF"]    # your own Slack user id(s), one per workspace you exist in (optional, ADR-0012/ADR-0042). For @mention detection in demand.list
discover_new = true           # detect "newly-joined conversations not in config" during sync and warn (optional, default true, ADR-0039). Set false to disable. Does not ingest
[connectors.slack.channel_since]
C0123ABCD = "90d"             # per-channel since override (optional, #57). Unspecified channels fall back to since. Same accepted formats as since (invalid values ConfigError at load time, #157)
```

- **Migrating from the ADR-0014 multi-workspace shape**: the `[connectors.slack.workspaces.<alias>]` tables, `team`, and `self_user_id` keys were **removed** ([ADR-0042](../adr/0042-slack-workspace-less-connector.md) 決定 9). A config still carrying them fails at load with a mechanical migration message: merge every workspace's channel ids into the one flat `channels` list, move per-alias `since` values into `[connectors.slack.channel_since]`, collect your user ids into `self_user_ids`, and store every workspace's token as one pool (`suasor slack auth set` / `SUASOR_CONNECTOR_SLACK_TOKENS`). The old per-alias env overrides (`SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN`) are no longer read.
- **Reachability + failover** ([ADR-0042](../adr/0042-slack-workspace-less-connector.md) 決定 3): with two or more live tokens, sync sweeps each token's joined conversations once (best-effort, advisory ordering) so every channel is fetched via a token that can read it, with **one bounded failover** to another token on failure. A token failing mid-sync (auth / rate limit / network) is marked failed and later channels stop picking it; its channels' cursors are preserved (not reset). The failure modes are told apart in warns and the summary: a **dead token** says "replace it" (`suasor slack auth set`), an **unreachable channel** (no token can read it) says "join/invite there, or add that workspace's token".
- **Discovering `self_user_ids`**: `slack auth test` verifies **every pool token**, prints each token's `user_id`, and suggests a paste-ready `self_user_ids = [...]` from the user tokens. Without any, `demand.list` **cannot detect @mentions and silently degrades to DM-only** ([ADR-0012](../adr/0012-slack-demand-digest.md) / [ADR-0041](../adr/0041-neutral-demand-priority-substrate.md)); `suasor doctor` surfaces this as an info hint.

  **Per-token summary + exit code** ([ADR-0042](../adr/0042-slack-workspace-less-connector.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)): when the pool has 2+ tokens (or any token is not ok), a single **per-token summary line** is printed at the end of sync (e.g. `slack: tokens: T0ACME "Acme"=ok, #2=dead (replace it), T0BETA=failed (cursor preserved)`). A **partial failure** (a dead/failed token, or a channel no token could ingest) exits with **exit 1** (records that were ingested are retained). Via `suasor sync` (all connectors at once, [ADR-0027](../adr/0027-bulk-sync-orchestration.md)) too, a Slack partial failure counts as a connector failure and the whole run exits 1.

  **Shared channels collapse naturally** ([ADR-0042](../adr/0042-slack-workspace-less-connector.md), supersedes [ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md)): in Enterprise Grid a single channel can be **shared across multiple workspaces** (cross-department, external BP collaboration, etc.). Because the externalId is canonical (`slack:<channel>:<ts>`, no team prefix) and a shared channel has one globally unique channel ID, listing the same channel ID in multiple aliases' `channels` produces the **same source ids from every alias** — the store's fingerprint idempotency absorbs the overlap, so nothing is double-ingested and no owner election is needed. A duplicated listing only costs a redundant fetch (each alias advances its own cursor). There is no shared-channel warn and no doctor check: the overlap is not a defect. Slack Connect (external-org sharing) also collapses under the canonical id (best-effort; channel IDs are globally unique across Slack).

  **Clean up legacy team-prefixed sources** (for environments that ingested **before** [ADR-0042](../adr/0042-slack-workspace-less-connector.md) canonicalized the identity): older syncs wrote message sources under `slack:<team>:<channel>:<ts>`; new syncs write `slack:<channel>:<ts>`. The event log keeps the old sources (events are immutable), so both lineages can appear in `search` / `demand.list` until you clean up. Because sync cursors carry over, the old lineage is historical only (new messages ingest solely under the canonical id). Cleanup: `suasor source list --type slack_message` and look for externalIds whose first segment after `slack:` is a team id (`T…`) rather than a channel id (`C…`/`G…`/`D…`), then `suasor source forget <externalId>` ([ADR-0026](../adr/0026-source-forgetting.md), destructive, apply with `--yes`) to redact the body and remove it from the projection / FTS / vector. To re-ingest that history under canonical ids afterwards, lower the floor with `suasor slack cursor backfill`.

  **Warn for channels you have not joined** ([ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) / [#165](https://github.com/ozzy-labs/suasor/issues/165)): `READY` from `auth test` is a judgement of **scope only**; reachability of a channel (membership) is a separate layer. For a channel the bot has not joined (has not been `/invite`d to), Slack returns `not_in_channel` at sync time and the channel stays **empty with no error** = it tends to be silent. So sync **aggregates `not_in_channel`** (and the channel-level unreachable errors `channel_not_found` / `is_archived`) **into a single warn per workspace**, making explicit which channels are unreachable (`workspace '<alias>': N channel(s) unreachable — C123 (not_in_channel), …`). This is a **per-channel** skip: it does not stop ingestion of other reachable channels in the same workspace, and preserves the prior cursor of an unreachable channel (does not reset). Workspace-wide errors such as `ratelimited` are handled by per-workspace isolation (above) as before.

- **identity**: `slack:<channel>:<ts>` (canonical, [ADR-0042](../adr/0042-slack-workspace-less-connector.md): channel ids are globally unique across Slack, so no team prefix — a shared channel collapses to one source lineage regardless of which workspace ingests it; the team stays a display facet under `meta`) / **source_type**: `slack_message`
- **thread replies** ([ADR-0015](../adr/0015-slack-thread-replies.md), revision R1): for each message in `conversations.history` whose parent has `reply_count > 0`, it follows `conversations.replies` and ingests the replies too (messages without replies are not called = N+1 suppression). Replies use the same identity / `threadTs` meta, and the per-channel cursor shares the maximum `ts` of history and replies. **Steady-state capture (R1):** because a reply does not appear in `conversations.history` once the channel cursor has moved past its parent (the normal cron case), the cursor map also keeps a per-thread high-water mark under a `<channel>#<thread_ts>` key. Every sync re-polls each **active** thread (a reply within the last 30 days) from its own mark, so "today's reply to yesterday's thread" is captured and its `<@you>` mentions reach `slack.demand.list`. Inactive threads are pruned (no re-poll), keeping the extra `conversations.replies` calls bounded to live threads. The re-poll runs on the SDK `WebClient`, inheriting its Retry-After rate-limit retry ([ADR-0019](../adr/0019-slack-fetch-rate-limit-retry.md) §3)
- **delta detection**: the `oldest` cursor of `conversations.history`. The cursor is a **flat** JSON map holding the latest `ts` per channel (`{ "<channel>": "<ts>" }`, [ADR-0042](../adr/0042-slack-workspace-less-connector.md)), and each channel resumes from its own high-water mark ([ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)). Per-thread high-water marks sit alongside the channel keys as `<channel>#<thread_ts>` entries (ADR-0015 R1); `slack status` folds them into a per-channel "active thread" count, and `cursor reset` / `cursor backfill` on a channel also clear that channel's thread marks. A legacy nested per-alias map (`{ "<alias>": { "<channel>": "<ts>" } }`, ADR-0014) is flattened once with a max-ts merge per channel (no cold restart on upgrade), and a single bare `ts` acts as the floor for the first run after upgrade
- **onboarding** ([ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)):

The wizard does all of the below in one command (the recommended path, #384):

```bash
suasor onboard --connector slack       # token(s) → auth test → joined channels → first sync
```

To wire it by hand:

```bash
suasor slack auth set                  # save the token pool to the keychain (stdin / --token, comma-separated for multiple)
suasor slack auth test                 # verify every pool token + granted scopes + feature readiness
suasor slack follow --suggest          # suggest-and-confirm: propose the joined channels, apply after one confirm (ADR-0042)
suasor slack sync                      # (= <connector> sync) ingest
```

Or inspect / paste by hand:

```bash
suasor slack conversations             # enumerate conversations visible to the pool and print a [connectors.slack] block
suasor slack conversations --new       # show only newly-joined conversations not in config (below)
# → paste the output block into config.toml and enable it, then run slack sync
```

**Follow / unfollow by name** ([ADR-0042](../adr/0042-slack-workspace-less-connector.md) 決定 6): day-to-day, channels are added and removed by **human name** (or id) — the tool resolves the name across the pool and edits the flat `channels` list surgically (your comments elsewhere survive; the **id is the truth**, the name is a comment label):

```bash
suasor slack follow '#eng-team'        # resolve the name across the pool → append the id
suasor slack follow C0123ABCD          # ids are accepted as-is (no network)
suasor slack follow --suggest [--yes]  # propose joined public/private channels not in config; one confirm applies
suasor slack unfollow '#noise'         # names resolve OFFLINE via the slack_channels projection
```

A name that matches two different channels (e.g. `#general` in two workspaces) errors with the candidates — re-run with the id. `--suggest` never proposes DMs / group-DMs (they stay opt-in via an explicit `follow`), and applying always takes **one confirmation** (`--yes` for headless) — auto-ingest without a confirm is deliberately not offered ([ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) HITL). Unfollowing leaves already-ingested history in place (purge with `suasor source forget`).

  `auth test` prints, per scope, the readiness of `public channel sync` / `private channel sync` / `DM sync` / `group-DM (mpim) sync` / `engagement axis` (`READY` / `READY (degraded: +users:read …)` / `MISSING <scope>` / `N/A (User Token only)`). READY only guarantees scope; an unjoined channel stays `not_in_channel` (membership is a separate layer). Unjoined channels are made explicit by the aggregated warn at sync time (the "Warn for channels you have not joined" above). To see reachability before configuring, use the membership mark of `slack conversations` (below)

  `conversations` output starts with a `Joined  ID / Name` label row and makes explicit that **column 1 is the membership mark and column 2 (id) is the value to paste into `channels`** ([#158](https://github.com/ozzy-labs/suasor/issues/158) / [#165](https://github.com/ozzy-labs/suasor/issues/165)). The **membership mark** `✓` means the token's principal is a member of that conversation (= reachable by sync); a channel with no mark is unjoined = it comes up empty with `not_in_channel` at sync time (ADR-0011; derived from Slack's `is_member`; DMs / group-DMs are always members. If there is at least one unjoined channel, a supplementary note is printed to stderr. `--json` includes `isMember` for each conversation). It is **sorted a-z within a type**, and **for DMs the counterpart's display name is resolved via `users.info`** and printed as `dm:<name>` (`users:read` required; falls back to `dm:<userId>` when unresolved). The `channels` in the emitted `[connectors.slack]` block is also the id (the `#` comment is only the display-name label). Sequential `users.info` resolution for DMs and `search.messages` pagination for `--sort=last_self_post` tend to be long, so **progress (processed count) is printed to stderr** (the same `createProgress` as `sync`, TTY only, disabled with `--no-progress`, #84).

  > **channels are ids (names not allowed).** In `channels` specify conversation **id**s (`C…` public / `G…` private/group-DM / `D…` DM). Pasting a channel **name** like `#general` means `conversations.history` cannot look up the id and results in **silent zero ingestion**, so at `sync` time a value not starting with `C/D/G` produces a warning (not hard-enforced = it does not lock out future id prefixes, [ADR-0007](../adr/0007-connector-contract.md) / [#158](https://github.com/ozzy-labs/suasor/issues/158)). Get ids with `suasor slack conversations`.

#### How to find new conversations (`--new`, [ADR-0039](../adr/0039-conversation-discovery-drift.md))

  `channels` is an **explicit list** (= data minimization and explicit control of the ingest scope, [ADR-0003](../adr/0003-local-first-and-content-minimization.md) / [ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)), so joining a new channel after initial setup is **not ingested automatically**. Missing it means "you joined but it never enters suasor" = the completeness of demand / search / brief drops. `suasor slack conversations --new` shows **only this drift (the difference between conversations visible to the token and `channels` in config)** (no need to eyeball the full list):

- **New** (`isMember` but not in config) is printed as a paste-ready `[connectors.slack]` fragment (reusing `renderConfigBlock`). Unjoined (no `✓`) conversations would be empty if ingested, so they are excluded from candidates.
- **Disappeared** (in config but unreachable by the token = left / archived / renamed) is surfaced with a warn on stderr (**not auto-deleted** = the ingestion decision is left to the operator).
- The default diff sweep is **public + private only** (DMs / group-DMs are noisy). You can widen it with `--types public,private,im,mpim`. A configured DM id is not misjudged as "disappeared" even when not swept.
- `--json` returns a **new shape, since it is a new flag**: `{ new: [...], removed: [...] }`. The existing full-enumeration `slack conversations --json` (`{ teamId, conversations, … }`) is **unchanged**.
- **Silent auto-follow is not the default** ([ADR-0039](../adr/0039-conversation-discovery-drift.md)). An append path (`--apply`) is to be decided in a follow-up PR (Layer 3).

##### Automatic detection during sync + `doctor` drift check ([ADR-0039](../adr/0039-conversation-discovery-drift.md) Layer 2)

  To remove the need to "run `--new` by hand every time", `slack sync` lightly sweeps `users.conversations` (public + private only) across the pool and, if there are **member conversations** outside config, prints a **single-line aggregated warn** (``N new conversation(s) visible but not in config — run `suasor slack conversations --new` …``). It **does not ingest and the cursor is unchanged** (preserving the privacy design of explicit enumeration).

- **opt-out**: `[connectors.slack] discover_new = false` (default `true`; connector-level only — the per-alias override went away with the aliases, [ADR-0042](../adr/0042-slack-workspace-less-connector.md)).
- **cadence (throttling)**: it does not call on every sync but sweeps **at most once per 24h** (pool-wide; every live token is swept and the drift union is reported). The last sweep time + new count are held lightly in a reserved key inside the connector cursor (separate from the channel cursors; not shown in `slack status` / `cursor reset`), creating no extra projection / event.
- **Single-run toggles ([ADR-0039](../adr/0039-conversation-discovery-drift.md) §3)**: CLI flags that change behavior for that run only without editing config (common to `connector-sync`, honored by Slack only):
  - `suasor slack sync --discover` — ignore the 24h cadence (and the `discover_new = false` opt-out) and **sweep immediately**. For checking drift right after joining a new channel.
  - `suasor slack sync --no-discover` — **suppress the sweep for that run** even if config has `discover_new = true` (the cadence marker and cursor are unchanged).
  - Specifying both at once is an error (contradictory). If neither is specified, it follows config (`discover_new` + cadence) as before. On non-Slack connectors both flags are no-ops (there is no discovery concept).
- **best-effort**: even if the sweep fails, it does not stop the sync itself or cursor advancement — only a warn. Rate-limiting rides on the shared `slackFetch` ([ADR-0019](../adr/0019-slack-fetch-rate-limit-retry.md)).
- **`suasor doctor`** does not hit the network; it reads the drift marker saved by this sweep and surfaces "N new Slack conversations not added" as a **WARN** (does not change the exit code; the diagnostic is offline, [ADR-0039](../adr/0039-conversation-discovery-drift.md)). With `discover_new = false` it shows the disabled state instead of a stale count.

- **demand signal** ([ADR-0012](../adr/0012-slack-demand-digest.md) / [ADR-0041](../adr/0041-neutral-demand-priority-substrate.md)): from ingested `slack_message`, @mentions (when `self_user_id` is set) / DMs are retrieved via the connector-neutral MCP `demand.list` as a "should-read but unprocessed" signal (derived from a query, no extra fetch) — alongside demand-worthy github notifications. It returns **outstanding (un-acked) demand only** by default; mark a row handled with `demand.mark`（`state="acked"`） / not-relevant with `demand.mark`（`state="dismissed"`） so it drops out. The `next-actions` / `personal-brief` skills fold it in at high priority via the deterministic `priority.list` scorer.
- **engagement axis** ([ADR-0013](../adr/0013-slack-engagement-axis.md)): `suasor slack conversations --sort=last_self_post` orders conversations by "when you last posted". Because it uses `search.messages` (`from:me`) it is **User Token (`xoxp-`) only**, degrading to `N/A` on a Bot Token (enumerated in normal order). Values are approximate due to Slack full-text index lag. The `last_self_post` column in the table is a human-readable time (`YYYY-MM-DD HH:MM (<relative-time>)`) (`--json` keeps raw ts, #84).
- **rate-limit retry** ([ADR-0019](../adr/0019-slack-fetch-rate-limit-retry.md)): the operational / discovery / auth / search fetch paths (`users.conversations` / `users.info` / `auth.test` / `search.messages`) do not die instantly on 429 but recover by honoring `Retry-After` (or 1s/2s/4s backoff when absent, 3 attempts by default) (shared `slackFetch`). The sync hot path (`conversations.history` / `replies`) delegates to `@slack/web-api`'s default retry (not held twice).
- **date floor / recovery** ([ADR-0016](../adr/0016-slack-sync-date-floor.md)): `since` (settable per-workspace) sets a cold-start floor. The floor applies only to channels with no saved cursor; a resumed channel prefers its cursor. The `since` / `channel_since` values are **validated as parseable at config load time**, and a value that parses as neither relative (`30d` / `4w` / `12h`) nor an ISO date (`2026-01-01`) (e.g. `"3 weeks"`) fails fast with `ConfigError` (preventing a silent degradation to "no floor" that would trigger a full-history backfill, [ADR-0007](../adr/0007-connector-contract.md) / #157). Operational verbs:
  - `suasor slack status [--json]` — show the stored cursor (resume ts per channel). The resume ts is printed as a human-readable time (`YYYY-MM-DD HH:MM (<relative-time>)`) so you can tell at a glance "which channel was ingested up to when" (`--json` keeps raw ts, #84)
  - `suasor slack cursor reset --channel C1,C2 | --all [--yes]` — clear the cursor and re-fetch from the `since` floor on the next sync (without `--yes` it is preview only)
  - `suasor slack cursor backfill --channel C1 --since 180d [--yes]` — lower the specified channel's cursor to the `--since` floor (older than the current position) and re-fetch the un-fetched window on the next sync (for backfilling older than the floor, #57)
  - `since` can also be overridden per-channel (`[connectors.slack.channel_since]`, #57)
  - `suasor slack resolve-names [--force] [--json]` — scan already-ingested `slack_message` sources and retroactively resolve channel / user ids whose names are still unresolved via `conversations.info` / `users.info` to enrich the projection (because forward sync only names newly-ingested items, [ADR-0037](../adr/0037-slack-name-enrichment.md) §11; each id resolves via the pool token whose workspace matches, with one failover, ADR-0042). Idempotent (ids that already have a name are skipped; re-resolve with `--force`). Ids with insufficient scope / API errors are skipped and it continues, printing a summary of resolved / skipped / degraded counts. This lets `slack status` / `cursor` / `demand.list` present conversations by human-readable name rather than id

## Microsoft Graph (`ms-graph`)

Ingests Microsoft 365 (Outlook mail / Calendar / OneDrive / Teams) (`@microsoft/microsoft-graph-client` + `@azure/msal-node`, app-only client-credential flow).

- **token**: the App registration's client secret. env override `SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET`, keychain account `connector:ms-graph:clientSecret`
- **multi-account**: add `[connectors.ms-graph.accounts.<account>]` to ingest more than one tenant / mailbox in one pass (per-account `clientSecret`, `tenantId`, `clientId`, `user`, and error isolation). See [Multi-account ingestion](#multi-account-ingestion-google--ms-graph--box)
- **config**:

```toml
[connectors.ms-graph]
tenantId = "<directory-id>"
clientId = "<app-client-id>"
user = "user@contoso.com"               # required: target mailbox / drive (UPN or object id)
resources = ["mail", "calendar"]        # mail | calendar | files | teams
```

> **`user` is required and has no default** ([ADR-0051](../adr/0051-ingest-scope-defaults.md), [#536](https://github.com/ozzy-labs/suasor/issues/536)). It used to default to `"me"`, which only resolves on a *delegated* token — this connector authenticates **app-only** (client credentials), where Graph reads `me` as a literal user id and answers 404. An install that never set `user` therefore synced nothing while looking like a permission problem. Unset is now reported by `doctor` as a `connectors.config` **error** and named by the sync pre-flight, instead of shipping a default that cannot work.

- **identity**: `msgraph:<resource>:<id>` / **source_type**: `ms365_mail` / `ms365_calendar` / `ms365_file` / `ms365_teams_message`
- **delta detection**: paginate the collection with `@odata.nextLink` and skip unchanged items by body fingerprint. `files` (OneDrive) uses the DriveItem content hash (`file.hashes.quickXorHash`, or sha256/sha1 if absent) as the fingerprint, so it **also detects content changes** without a rename and re-extracts ([ADR-0024](../adr/0024-document-extraction-sidecar.md) §6). When the hash is absent it falls back to the SHA-256 of the body (file name)
- **Body extraction (OneDrive `files`)** ([ADR-0024](../adr/0024-document-extraction-sidecar.md) / [ADR-0034](../adr/0034-api-connector-extraction.md), #243): with the `[extraction]` sidecar enabled, Office/PDF (`.docx`/`.xlsx`/`.pptx`/`.pdf`) in the `files` resource are **read-only** lazy-fetched via the Graph API (`GET /users/{user}/drive/items/{id}/content`) and replaced with the extracted text. It goes through the same shared base (the extraction stage in `src/connectors/sync.ts`) as `local` / `box`. mail / calendar / teams ingest their text body as-is and are not extraction targets. Other files are **name-only**. See the [extraction guide](extraction.md) for details and degrade behavior
- **size guard**: if the DriveItem `size` exceeds `[extraction].maxBytes` it is not fetched and is name-only. fetch / extraction failure and unsupported also degrade to name-only (ingestion itself succeeds)
- **onboarding** (Issue #85): `suasor ms-graph auth set` (save the client secret to the keychain) / `suasor ms-graph auth test` (verify the client secret + tenantId/clientId connectivity via a client-credential token exchange and print granted scope). `auth test` requires `tenantId` / `clientId` in config; without `user` it still reports the credential and scopes, and prints every configured resource as `UNKNOWN — not probed` (there is nothing to probe under).
- **feature readiness** (Issue #194): `auth test` prints a `features:` line per `resources` in config (same format as Slack). client-credential returns `.default`, and the actual application permissions (Mail.Read / Calendars.Read / Files.Read.All / Channel / Chat.Read.All) are resolved server-side and not enumerated in the token `scope`, so each line is `N/A (scopes not enumerated)` (check the actual permissions on the Azure app registration side). If `resources` is unset, only a single line `ingestion: N/A (no resources configured)`:

  ```text
  ok: ms-graph credential for app <client-id> @ tenant <tenant-id>
  scopes: https://graph.microsoft.com/.default
  features:
    mail read (Mail.Read): N/A (scopes not enumerated)
    calendar read (Calendars.Read): N/A (scopes not enumerated)
  ```

- **resource reachability** ([ADR-0049](../adr/0049-connector-readiness-parity.md), [#478](https://github.com/ozzy-labs/suasor/issues/478)): because the scope layer above structurally cannot answer anything for ms-graph, `auth test` additionally sends **one read-only GET per configured resource** under the configured `user` and reports what the API said, in a separate `resources (live probe):` block. A mistyped UPN, or a `user` written as `"me"` (still accepted, still 404 under an app-only credential), surfaces here instead of as a sync that ingested nothing. Verdicts are `REACHABLE` (2xx) / `UNREACHABLE` (401/403 = permission, 404 = the configured id does not exist for this credential) / `UNKNOWN` (transport failure, timeout, 5xx, **or nothing to probe because `user` is unset**). `UNKNOWN` is **never** reported as reachable. Pass `--no-probe` to skip it.

  ```text
  resources (live probe):
    mail: UNREACHABLE — mailbox of "typo@contoso.com": HTTP 404, not found — check the configured id (ResourceNotFound: …)
    calendar: REACHABLE — calendar of "you@contoso.com" readable
  ```

## Google

Ingests Google Workspace (Drive / Gmail / Calendar) (`googleapis`, OAuth2 refresh token).

- **token**: OAuth refresh token (read scope for the target APIs). env override `SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN`, keychain account `connector:google:refreshToken`
- **multi-account**: add `[connectors.google.accounts.<account>]` to ingest a personal *and* a work account in one pass (per-account credential, `calendarIds`, `resources`, `self_addresses`, and error isolation). See [Multi-account ingestion](#multi-account-ingestion-google--ms-graph--box)
- **config**:

```toml
[connectors.google]
clientId = "<oauth-client-id>"
calendarIds = ["primary", "team@group.calendar.google.com"]  # every calendar to ingest
resources = ["drive", "gmail", "calendar"]  # drive | gmail | calendar
```

> **`calendarId` (singular) was replaced by `calendarIds` (a list)** ([ADR-0051](../adr/0051-ingest-scope-defaults.md), [#536](https://github.com/ozzy-labs/suasor/issues/536)) — a breaking change. One account routinely owns several calendars that matter (your own plus a team calendar), and a single id made every other one unreachable.
>
> **Migration**: rewrite `calendarId = "X"` as `calendarIds = ["X"]`, in `[connectors.google]` and in every `[connectors.google.accounts.<account>]` that sets it. The old key is **not** silently promoted: a config that still uses it fails to load with an error naming the exact replacement line. Run `suasor google calendars` to enumerate the ids you can add.
>
> **Identity**: with **one** configured calendar the external ids are unchanged (`google:calendar:<eventId>`), so an existing install's ingested calendar sources stay addressable. Listing a **second** calendar namespaces them (`google:calendar:<calendarId>:<eventId>`) — necessary because one meeting carries the same event id in every calendar it appears on, and two calendars would otherwise fight over a single source. The consequence is a one-time re-ingest of the first calendar's events under the new ids, with the old rows left behind (`suasor source forget` removes them).

- **identity**: `google:<resource>:<id>` (calendar events add the calendar id when several are configured — see above) / **source_type**: `google_drive` / `gmail_message` / `google_calendar`
- **delta detection**: paginate with `nextPageToken` and skip unchanged items by body fingerprint. Drive files use a **content fingerprint** (`md5Checksum` for binary, and the monotonically increasing `version` for Google-native files since they have no md5), so content changes without a rename are detected and re-ingested / re-extracted. Gmail / Calendar stay on the body SHA-256 fingerprint
- **onboarding** (Issue #85): `suasor google auth set` (save the refresh token to the keychain) / `suasor google auth test` (verify connectivity via a refresh→access token exchange and print granted scope). `auth test` requires `clientId` in config, and for an installed/web client it also uses `connector:google:clientSecret` if you place it in the keychain (not needed for a public client).
- **calendar discovery** ([ADR-0030](../adr/0030-connector-discovery-verbs.md)): hand-copying a calendar id from the Web UI easily produces a typo that makes calendar sync **silently return 0**. Use the discovery verb that enumerates calendars visible from the token so you can paste them (the equivalent of github's `github repos`):

  ```bash
  suasor google calendars                  # enumerate visible calendars and print a [connectors.google] block
  suasor google calendars --new            # only what the token sees that calendarIds does not list (drift)
  suasor google calendars --filter team    # filter by substring match on id / summary (case-insensitive)
  suasor google calendars --json           # print items + configBlock as JSON
  ```

  After exchanging the refresh token for an access token, it enumerates `GET /calendar/v3/users/me/calendarList` (`nextPageToken` pagination) with `fetch` only (no `googleapis` dependency, import-clean, [ADR-0007](../adr/0007-connector-contract.md)) and prints calendar id / summary / timeZone / primary. It requires `clientId` in config, and an installed/web client also uses `connector:google:clientSecret` from the keychain (same shape as `auth test`). Like github's `repos`, the paste-ready `[connectors.google]` block lists every visible calendar in a `calendarIds = [ ... ]` array — **every line in it is ingested**, so delete the ones you do not want (holiday / birthday calendars are visible too). The refresh token / client secret / access token are never leaked in errors.
- **feature readiness** (Issue #194): `auth test` prints a `features:` line per `resources` in config (same format as Slack). Because Google's token response enumerates granted scope URLs, each resource's scope (`drive` / `gmail` (or `mail.google.com`) / `calendar`) is `READY` if included in the granted scopes and `MISSING <scope>` otherwise. If `resources` is unset, only a single line `ingestion: N/A (no resources configured)`:

  ```text
  ok: google credential for client <client-id>
  scopes: https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly
  features:
    Drive read: READY
    Gmail read: READY
    Calendar read: MISSING calendar
  ```

- **resource reachability** ([ADR-0049](../adr/0049-connector-readiness-parity.md), [#478](https://github.com/ozzy-labs/suasor/issues/478)): a granted scope says the permission was asked for; it does not say the resource you configured is readable. `auth test` therefore also sends **one read-only GET per configured resource** and prints a separate `resources (live probe):` block. The calendar probe reads **every configured `calendarIds` entry** (one row each), not a generic calendar list — so the typo the discovery verb above exists to prevent is caught here too, as a 404 instead of a silent 0-count sync. Verdicts are `REACHABLE` / `UNREACHABLE` (401/403 = permission, 404 = the configured id does not resolve) / `UNKNOWN` (transport failure, timeout, 5xx, or an empty `calendarIds` leaving nothing to probe — never reported as reachable). The `features:` block stays as its own block: a granted scope and a live API answer have different confidence, so they are not folded into one line. Pass `--no-probe` to skip it.

  ```text
  resources (live probe):
    drive: REACHABLE — Drive file list readable
    calendar: REACHABLE — calendar "primary" readable
    calendar: UNREACHABLE — calendar "teem@group.calendar.google.com": HTTP 404, not found — check the configured id
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

- **multi-account**: add `[connectors.box.accounts.<account>]` to ingest a personal *and* a work Box account in one pass (per-account `token`, `folders`, and error isolation). See [Multi-account ingestion](#multi-account-ingestion-google--ms-graph--box)

```toml
[connectors.box]
enabled = true

[connectors.box.accounts.personal]
folders = ["0"]                          # "0" is *this* account's root

[connectors.box.accounts.work]
folders = ["224466"]
```

```bash
suasor box auth set --account work       # → keychain connector:box:work:token
suasor box auth test                     # tests every configured account
```

- **identity**: `box:file:<id>` — `box:<account>:file:<id>` for a named account / **source_type**: `box_file`
  - The account prefix is **required for correctness**, for two independent reasons. A Box *collaboration* does not copy: a file shared into both of your accounts is the same object with the **same** file id in each, so without the prefix the two accounts would write one source row and it would keep whichever account's attribution ran first. And Box does not document a uniqueness scope for ids at all — the one id in this family that *is* documented, the root folder `0`, is explicitly per account ([Box API reference](https://developer.box.com/reference/get-folders-id/)), so "file ids happen to be globally unique" is an assumption we decline to depend on rather than a guarantee we can quote
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

## 同期フォルダと API connector の二重取り込み

OS 同期された Box / OneDrive / Google Drive のマウントを `local` connector の root にしつつ、**同じサービスの API connector も有効にする**と、重なるファイルが **2 つの identity で二重に取り込まれる**（`local:<sha1(path)>` と `box:file:<id>` など）。source 行・FTS 行・embedding・検索ヒットがすべて二重になり、**extraction 有効時は両経路が全文を持つので最も無駄が大きい**。

`suasor doctor` が `connectors.overlap` として警告する（[#514](https://github.com/ozzy-labs/suasor/issues/514)）:

```text
warn  connectors.overlap  local root /Users/me/Box/Projects looks like a Box Drive mount
                          while the 'box' connector is also enabled — the same files are
                          ingested twice under different ids …
```

**どちらか一方に寄せる** — root を外すか、API connector を無効にする。判断材料:

- **API connector 側に寄せる**: 共有・権限・更新者などのメタデータが取れる。同期フォルダを常時マウントしていない環境でも動く
- **`local` 側に寄せる**: API の rate limit を消費しない。同期済みなのでオフラインでも読める

検出は**マウント名のヒューリスティック**（環境依存なので確実ではない）。警告止まりで exit code は変えない。

## Adding a new connector

1. Write the `Connector` implementation and factory in `src/connectors/<name>.ts` (lazy-import the SDK inside `sync`)
2. Add one line `<name>: () => import("./<name>.ts")` to `src/connectors/registry.ts`
3. Register in `SECRET_NAMES` in `src/connectors/registry.ts` the secret names the connector reads via `ctx.secret(...)` (`[]` if no auth is needed). The token-configured introspection of `suasor connectors list` references this
4. Zod-validate the `[connectors.<name>]` config slice on the connector side

The CLI `suasor <name> sync` and MCP `connector.sync` automatically become available from the registry, and it automatically appears in `suasor connectors list`.
