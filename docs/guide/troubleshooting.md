# Troubleshooting

This guide walks the common failure modes as a **diagnose → fix** decision tree. Most are *silent* symptoms — "sync succeeds but nothing shows up in search", "the count never grows" — whose cause spans multiple layers. Start by taking stock with the two read-only verbs below, then move on to the individual scenarios.

- `suasor doctor` — diagnoses whether config / DB / embedding / connectors are **wired or missing** (exits 1 when it finds an error; [ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md))
- `suasor store info` — surfaces the **size** of the store (event-log count / projection rows / DB size / vec0 / FTS); read-only ([Issue #202](https://github.com/ozzy-labs/suasor/issues/202))

```bash
suasor doctor                       # health check across all layers (exit 1 if any error)
suasor store info                   # store-size snapshot
suasor store info --breakdown       # aggregate the event log by type (for rebuild/replay debugging)
```

## v0.3 へのアップグレード: agent surface の収縮（ADR-0046）

MCP tool と skill の**名前が変わった**（後方互換の alias は残していない・[ADR-0046](../adr/0046-agent-surface-contraction.md) 決定 5）。host 設定・自作 skill・スクリプトが旧名を参照している場合は機械的に置換する。

### MCP tool（45 → 39）

| 旧 | 新 |
|---|---|
| `recall.search` | `search`（`mode: "semantic"`） |
| `search.hybrid` | `search`（`mode: "hybrid"`） |
| `source.get.full` | `source.get`（`include: ["links", "extraction"]`） |
| `commitment.resolve` | `commitment.set`（`state: "resolved"`） |
| `commitment.dismiss` | `commitment.set`（`state: "dismissed"`） |
| `commitment.reopen` | `commitment.set`（`state: "open"`） |
| `demand.ack` | `demand.mark`（`state: "acked"`） |
| `demand.dismiss` | `demand.mark`（`state: "dismissed"`） |

`search` の既定は `mode: "auto"`（embedding があれば hybrid、無ければ FTS）。**呼び出し側でアルゴリズムを選ぶ必要はなくなった**。

### skill（32 → 22）

| 旧 | 新 |
|---|---|
| `personal-brief` / `catchup` / `weekly-review` / `external-brief` / `health-check` | `brief` |
| `doc-review` / `pr-review` / `doc-diff` | `source-review` |
| `find-document` / `research` | `find` |
| `meeting-prep` / `action-item-status` | `meeting` |
| `decision-log` / `decision-rationale` | `decisions` |
| `announcement-draft` / `handoff-draft` | `draft` |

**旧 skill を install 済みの環境では、古い mirror が残る**（install は上書きするが削除はしない）。`suasor skills list` が旧名を `modified` / 孤児として出したら、mirror ディレクトリを手で消す:

```bash
rm -rf ~/.claude/skills/{personal-brief,catchup,weekly-review,external-brief,health-check}
rm -rf ~/.claude/skills/{doc-review,pr-review,doc-diff,find-document,research}
rm -rf ~/.claude/skills/{meeting-prep,action-item-status,decision-log,decision-rationale}
rm -rf ~/.claude/skills/{announcement-draft,handoff-draft}
suasor skills install   # 新しい catalog を展開
```

`.agents/skills/` 側も同様。

## Every command fails right after an upgrade (`invalid connector configuration`)

A config that a **breaking release** removed keys from fails at load, so *every* verb that reads config stops with the same error until the config is migrated. This is deliberate — a silently-ignored key would sync the wrong scope ([ADR-0007](../adr/0007-connector-contract.md) "no silent wrong answer"). The error text carries the migration.

**Slack, upgrading from `0.1.x` to `0.2.0`** ([ADR-0042](../adr/0042-slack-workspace-less-connector.md)): the multi-workspace shape is gone.

```text
error: invalid connector configuration
  connectors.slack: remove 'workspaces' — the workspace-less shape is a single flat
  [connectors.slack] with 'channels' … and one token pool …
```

Migrate in three mechanical steps (details + examples in the [connectors guide](connectors.md#slack)):

1. **config** — merge every `[connectors.slack.workspaces.<alias>].channels` into the one flat `[connectors.slack] channels` list (channel ids are globally unique, so no grouping is needed). Drop `workspaces` / `team` / `self_user_id`; move per-alias `since` into `[connectors.slack.channel_since]`, and collect your own user ids into `self_user_ids = ["U…"]`.
2. **tokens** — store every workspace's token as **one pool**, replacing the per-alias secrets: `suasor slack auth set` (comma-separated for multiple) or the env override `SUASOR_CONNECTOR_SLACK_TOKENS`. The old `SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN` overrides are no longer read.
3. **verify** — `suasor slack auth test` (checks every pool token) then `suasor doctor`.

Cursors carry over automatically (the per-alias map is flattened with a max-ts merge), so the next sync resumes rather than cold-starting. Messages ingested before the upgrade keep their old `slack:<team>:<channel>:<ts>` ids and stay searchable as a separate lineage; the optional cleanup is in the [connectors guide](connectors.md#slack).

## Reading the diagnostics

### `suasor doctor`

Each check carries `ok` / `info` / `warn` / `error`, and **a single `error` makes it exit 1** (usable as a cron / CI gate). It never prints secret values (NFR-PRV-4). The main checks:

- **config** — whether `config.toml` exists and loads
- **database** — whether `storage.dbPath` exists and the core projection tables (`sources` / `tasks` / `sync_runs` / `decisions` / `inbox` / `proposals` / `commitments` / `links` / `persons` / `person_identities`) are present (it never creates the DB — diagnosis only). The check detail derives the table count dynamically from the set in `src/db/schema.ts`, so the count stays accurate when new projections are added.
- **embedding** — the `[embedding].backend` setting (`disabled` is INFO). When a backend is enabled it also probes `embedding.dim` to check that **the model's output dimension matches `[embedding].dim`** (see "Dimension mismatch" below).
- **connectors** — whether enabled connectors have credentials configured (missing is WARN). A *dangling credential* — `auth set` done but `[connectors.<name>]` not enabled — is also WARN.
- **connectors.config** — an enabled connector missing a **required non-secret setting** (google `clientId`, ms-graph `tenantId` / `clientId`, jira `host`) is an **ERROR**: unlike an empty ingest scope, the connector cannot address its API at all and the sync fails with the vendor's own opaque message ([ADR-0049](../adr/0049-connector-readiness-parity.md)). Reported as its own line, never folded into the empty-scope WARN.
- **maintenance** — surfaces drainable backlog such as `pending embeddings` / `stale embeddings` / `extraction version drift` as WARN (a maintenance hint; does not affect the exit code).

### `suasor store info --breakdown`

Aggregates the event log by `type` (`COUNT(*) GROUP BY type`, read-only) and prints it ([Issue #270](https://github.com/ozzy-labs/suasor/issues/270)). Use it for rebuild / replay debugging or to understand "what was ingested from which connector". Example:

```text
  events by type:
    SourceObserved           1240
    SourceBodyUpdated         312
    ConnectorSyncCompleted     48
```

- `SourceObserved` / `SourceBodyUpdated` are 0 → nothing was ingested at all (→ [sync returns 0 items](#sync-returns-0-items-nothing-ingested))
- `SourceObserved` is present but the `sources` row count in `projections` is unexpectedly low → suspect projection drift (rebuild from the event log with `suasor projections rebuild`)
- Add `--json` for a machine-readable `eventBreakdown` (`{type, count}[]`)

## sync returns 0 items (nothing ingested)

`suasor sync` / `suasor <connector> sync` exits 0 but the count does not grow.

1. **scope not set** — the connector has not been told "where to look". When GitHub's `repos` / Google's `calendars` / Box's `folders` and the like are empty, there is **nothing to ingest** even though auth passes.
   - Enumerate the visible scope with a discovery verb to get a paste-ready config block:

     ```bash
     suasor github repos       # visible repositories → [connectors.github] block
     suasor google calendars   # visible calendars → [connectors.google] block
     suasor box folders        # visible folder tree → [connectors.box] block
     ```

   - See the [connectors guide](connectors.md) for details. Hand-writing `owner/repo` and the like invites a typo that silently yields 0 items.
   - **A missing Slack token pool does not fall under this section (exit 0 with 0 items)** — when the pool is empty, `slack sync` errors with `no token pool configured` and **exits 1** regardless of whether channels are set ([#385](https://github.com/ozzy-labs/suasor/issues/385)). Set the pool with `suasor slack auth set` (or the env override `SUASOR_CONNECTOR_SLACK_TOKENS`, newline/comma separated), then fill in channel ids with `suasor slack conversations`.
2. **cursor is already up to date** — incremental sync only ingests what is newer than the saved cursor. If there is nothing new, 0 items is normal. To rescan everything, use `--full`:

   ```bash
   suasor <connector> sync --full   # ignore the saved cursor and rescan everything
   ```

3. **the connector is not enabled** — the `[connectors.<name>]` slice is missing or `enabled = false`. Check with `suasor doctor`'s connectors check (including the dangling-credential WARN) and `suasor connectors list`.
4. **check whether a partial failure is hidden behind exit 0** — a connector with multiple ingest units inside it (Slack's token pool, etc.) reports a partial failure via `SyncOutcome.partialFailure` and **exits 1** ([ADR-0042](../adr/0042-slack-workspace-less-connector.md)). Check the per-token summary in the human-readable output (`tokens: T0ACME "Acme"=ok, #2=dead ...`).
5. **the configured id is not actually reachable** — a granted scope does not mean the id you wrote resolves. For google / ms-graph, `suasor <connector> auth test` probes each configured resource live and prints `REACHABLE` / `UNREACHABLE` / `UNKNOWN` ([ADR-0049](../adr/0049-connector-readiness-parity.md)); a mistyped `calendarId` or an app-only `user = "me"` shows up as `UNREACHABLE … HTTP 404`. `UNKNOWN` means the probe could not tell — it is not a pass.
6. **only one of your accounts is syncing** — `google` / `ms-graph` can ingest several accounts (`[connectors.<name>.accounts.<account>]`, [ADR-0050](../adr/0050-multi-account-connectors.md)). Two things to check:

   - `suasor doctor` reports credentials, required settings and `self_addresses` **per account** (`google (account 'work'): …`), and `suasor connectors list` shows `token: missing (accounts: work)`. An account with no credential is skipped with a warning and makes the run **exit 1**.
   - If you added an `accounts` table to a config that was already syncing, the flat `[connectors.<name>]` keys became inherited defaults and are **no longer an account of their own**. `doctor`'s `connectors.accounts` line says so — as a WARN when a credential for the unnamed default account is still stored, as INFO when there is no evidence either way. Add an (empty) `[connectors.<name>.accounts.default]` to keep ingesting it.

7. **what you expected to ingest was never in config** — Suasor only ingests ids you explicitly enumerate. `suasor <connector> <verb> --new` (github `repos` / notion `databases` / jira `projects` / box `folders`) shows exactly what the credential can see that config does not list, and what config lists that is no longer visible ([ADR-0049](../adr/0049-connector-readiness-parity.md)).

## Nothing in search (FTS is fine but recall is empty)

Results appear in `suasor search` (FTS5 full-text search) but 意味検索 (semantic search) is empty, or recall does not work even after enabling embedding. Embedding is an **optional add-on**; FTS works fully even when it is off ([ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)).

### embedding sidecar down / `embedding_disabled`

- When the backend is **unset (disabled by default)**, 意味検索 returns empty plus an `embedding_disabled` signal, and the host falls back to `search` (FTS) — graceful degradation. This is behaving as designed.
- recall is empty despite an enabled backend → the sidecar (Ollama) may be down, or an external API key may not resolve. `suasor doctor`'s embedding check surfaces this (an unresolved API key is a readiness WARN).
- Embedding during a sync run is **best-effort**. A sidecar failure stays a warning (stderr) and the ingest itself still succeeds (`warning: <connector> embedding skipped: ...`). To backfill embeddings afterward:

  ```bash
  suasor embeddings drain      # embed the not-yet-embedded (pending) sources
  suasor embeddings status     # check embedding coverage / pending / stale
  ```

- See the [embedding guide](embedding.md) for setup details.

### Dimension mismatch (model dim ≠ config dim → recall empty)

**The hardest failure mode to notice** ([Issue #267](https://github.com/ozzy-labs/suasor/issues/267)). `[embedding].dim` sets the dimension of the vec0 table. When it **disagrees with the model's actual output dimension**, every vector insert fails and **recall silently degrades to empty** (sync stays exit 0).

- **Diagnosis**: `suasor doctor` probes `embedding.dim` (embeds one item with the model and compares the output length) and reports it as an error:

  ```text
  [ERR ] embedding.dim   model "text-embedding-3-small" returns 1536-dim but [embedding].dim is 1024;
                         vector inserts fail and recall degrades to empty. Set [embedding].dim = 1536
                         (needs a fresh DB / delete + rebuild + re-sync). See docs/guide/embedding.md.
  ```

- **Fix**: set `[embedding].dim` to **match the model's output dimension** (bge-m3=1024 / nomic-embed-text=768 / text-embedding-3-small=1536, etc.).

  ```toml
  [embedding]
  backend = "ollama"
  model = "bge-m3"
  dim = 1024            # ← must match the model's output dimension
  ```

- **Important**: because `dim` defines the vec0 schema, **changing it later will not be consistent with existing vectors**. Create a fresh DB, or fix `dim` and rebuild the DB → then `suasor sync` (re-ingest) / `suasor embeddings rebuild` (re-embed) is required.
- Keep `model` identical for ingest and query (vector-space consistency).

## Ingested Office/PDF but the body text isn't searchable

You ingested Word / Excel / PowerPoint / PDF but `search` / 意味検索 does not hit the **body text** — only the filename matches. These are ingested **name-only** (body not extracted) by default; making the body searchable needs the `[extraction]` sidecar ([ADR-0024](../adr/0024-document-extraction-sidecar.md) / [extraction guide](extraction.md)). It is a silent "sync is exit 0 but there is no body" symptom, and it has several causes.

First make the current state visible (roll-up → drilldown):

```bash
suasor extraction status              # backend / version and the extracted/stale/pending/unsupported/too-large tallies
suasor extraction list-pending        # list which files are actually waiting for (re)extraction (--json for machine-readable)
suasor doctor                         # extraction backend / version and maintenance hints (drift/pending) in one line
```

1. **`[extraction]` unset (disabled by default)** — without it, ingestion stays name-only as before. `extraction status` shows `backend=disabled`. Start the bundled sidecar and enable the backend, then re-sync (one command each — no self-authored HTTP wrapper needed, [extraction guide](extraction.md)):

   ```bash
   uv tool install 'markitdown[all]'     # markitdown CLI on PATH (once)
   suasor extraction serve               # the bundled markitdown shim (POST /extract)
   # then set [extraction].backend = "markitdown" and re-sync the owning connector
   ```

   Once enabled, already-ingested files are **auto-backfilled on the next sync** (drift detection).
2. **sidecar down / unreachable** — the backend is set but the extraction sidecar is down or `baseUrl` is not reachable. Extraction during sync is **best-effort**: on failure the ingest itself still succeeds (the filename lands in FTS), it degrades to name-only, and only a warning (stderr) is emitted. Start the sidecar (`suasor extraction serve`) and re-sync the owning connector to clear the pending items:

   ```bash
   suasor local sync     # / suasor box sync / suasor google sync, i.e. the owning connector
   ```

3. **`too_large` (`maxBytes` exceeded)** — `too-large` is climbing in `extraction status`. Box / OneDrive / Drive(binary) judge by the `size` metadata before fetching and drop oversized files to name-only (so the store/FTS does not bloat). If you need the body, raise `[extraction].maxBytes` and re-sync.
4. **`unsupported` (format the sidecar does not handle)** — a format for which the sidecar returned `{ "text": null }`; the `unsupported` bucket in `extraction status`. Confirm the format is one markitdown supports (docx/xlsx/pptx/pdf).
5. **extractor version drift (`stale`)** — after bumping `[extraction].version` or improving the sidecar, any source whose recorded version in `extraction_meta` disagrees with the current one is treated as `stale` and **re-extracted on the next sync even if its content is unchanged**. Items shown as `[stale]` in `extraction list-pending` are backfilled by syncing the owning connector. `suasor doctor` also surfaces `extraction version drift: N` as WARN.

> **Note**: re-extraction only happens on a **connector sync** (`embeddings rebuild` only regenerates embeddings and does not re-extract; [embedding guide](embedding.md)). extraction drift and embedding drift are separate domains, so when the body text is missing, look at `extraction status` first.

## rate-limit / backoff (sync is slow / 429s)

When a connector / embedding API returns 429 (Too Many Requests) or 5xx.

### Automatic retry / backoff behavior (A/B)

- Connector auth / fetch and embedding calls go through a shared retry policy (`src/util/retry.ts`). It **automatically retries 429 / 5xx with exponential backoff + full jitter** and honors the `Retry-After` header (max wait is clamped to 60 seconds). The default attempt count is 3.
- google / box / ms-graph use `fetchWithRetry` for token exchange and the like, and the googleapis / microsoft-graph SDKs also retry 429 with their default RetryHandler ([Issue #269](https://github.com/ozzy-labs/suasor/issues/269)).
- On the embedding side you can tune `[embedding].maxRetries` (default 3) / `[embedding].requestTimeoutMs` (default 60000ms; on exceed it aborts → retries):

  ```toml
  [embedding]
  maxRetries = 3            # max retries for 429 / 5xx / timeout
  requestTimeoutMs = 60000  # per-request timeout (ms; 0 disables)
  ```

### Tuning `--concurrency` (B)

`suasor sync` (bulk ingest) runs **connectors in parallel through a bounded pool** (different API hosts = independent rate-limit buckets; [ADR-0027](../adr/0027-bulk-sync-orchestration.md) / [Issue #269](https://github.com/ozzy-labs/suasor/issues/269)). **Within a connector, per-resource work stays serial** (googleapis / graph.microsoft share a quota; [ADR-0014](../adr/0014-slack-multi-workspace.md)).

```bash
suasor sync                      # default concurrency 4
suasor sync --concurrency 2      # lower it (ease rate-limit / sidecar contention)
suasor sync --concurrency 8      # raise it (> 8 only warns)
```

- The default is 4. Specifying `> 8` warns that it "may contend for a shared sidecar / API rate limit" (it does not exit).
- **Frequent 429s / a shared sidecar (embedding, extraction) is congested** → lower `--concurrency`.
- **Network wait dominates and the API rate limit has headroom** → raise it. For most uses the default 4 is enough.
- `--no-continue-on-error` (fail-fast) runs **serially** to preserve order-dependent semantics (concurrency is ignored).

## Projections disagree with the event log

Projections (the read model) can be rebuilt from the event log by replay ([ADR-0002](../adr/0002-event-sourced-architecture.md)). When the `projections` row count is unnaturally low / stale relative to `store info`'s `events` / `events by type`:

```bash
suasor store info --breakdown    # check the gap between event count and projection rows
suasor projections rebuild       # replay the event log to rebuild projections
suasor db migrate                # migrate first if the projection schema is not applied
```

Projections are disposable and can be rebuilt (the event log is the source of truth). When in doubt, try `projections rebuild` first.

> **Caution (embedding enabled):** `projections rebuild` also clears the embedding sidecar — both the vec0 vectors and their `embeddings_meta` provenance — because neither is replayable from the event log ([ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md) §5). Right after a rebuild, semantic recall returns empty. Recover it with a single `suasor embeddings drain` (a plain `sync` will not, since it only re-embeds new or changed sources). The rebuild command prints this reminder whenever it actually cleared vectors, and `suasor doctor` flags a vec0 ↔ `embeddings_meta` row-count mismatch as an error.

## Further reading

- Full command / flag reference: [docs/design/cli.md](../design/cli.md)
- Embedding / semantic-search setup: [embedding guide](embedding.md)
- Per-connector setup: [connectors guide](connectors.md)
- Scheduling and failure monitoring: [scheduling guide](scheduling.md)
- Auditing / purging ingested data: [data-audit guide](data-audit.md)
