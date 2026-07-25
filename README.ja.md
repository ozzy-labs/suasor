# Suasor

[![npm version](https://img.shields.io/npm/v/@ozzylabs/suasor)](https://www.npmjs.com/package/@ozzylabs/suasor)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/ozzy-labs/suasor/actions/workflows/ci.yaml/badge.svg)](https://github.com/ozzy-labs/suasor/actions/workflows/ci.yaml)
[![ghcr.io](https://img.shields.io/badge/ghcr.io-ozzy--labs%2Fsuasor-blue?logo=docker)](https://github.com/ozzy-labs/suasor/pkgs/container/suasor)

**集め、覚え、助言する - 決めるのはあなた。**

Suasor はローカルファーストの AI 秘書です。チャット・メール・カレンダー・ドキュメント・コード・Web に散らばった業務情報をプライベートメモリに集め、あなたと AI エージェントが MCP 経由で検索・要約できるようにします。そして、助言し、返信・タスク・決定を提案します。さらに、あなたが承認すれば代わりに操作を実行することもできます（タスクの公開、Issue の状態遷移など）。取り込みは read 専用で、あなたの承認なく egress することはありません。

[English →](README.md)

## できること

- **集める** — あちこちのツールに散らばった業務情報を、手元のプライベートなストアに 1 か所へ集めます。**取り込みは read 専用**で、集める処理が元のソースに書き戻すことはありません。
- **覚える** — それを検索・参照できる記憶として、あなたのマシン上に保持します。
- **助言する** — MCP 経由で提示・要約し、返信・タスク・決定を提案します。あなたと AI エージェントが引き出し、実行するかはあなたが決めます。承認した操作（GitHub / Jira へのタスク公開、Issue の状態遷移など）は Suasor があなたの代わりに実行しますが、承認なく egress することはありません（[ADR-0036](docs/adr/0036-task-external-home.md)）。

## 対応しないこと（Boundaries）

これらの線引きが、Suasor をローカルファースト・HITL（人が承認する）助言者として保ちます（[docs/requirements/scope.md](docs/requirements/scope.md) 参照）:

- **承認なしの egress / 自動送信なし** — 取り込みは read 専用で、あなたの明示的な承認なしに外部へ何も出しません。承認済みの操作（`task.publish` / `task.act` によるタスク公開・Issue 状態遷移など）は Suasor があなたの代わりに実行します — ただし承認後のみで、自動実行はしません（[ADR-0004](docs/adr/0004-mcp-agent-boundary-and-hitl.md) / [ADR-0036](docs/adr/0036-task-external-home.md)）。
- **常駐の能動エージェントなし** — デーモンや非要求の通知は持たず、すべて人/エージェント起点です。
- **重い in-process ML なし** — モデルの学習・推論は委譲し、in-process では実行しません（[ADR-0006](docs/adr/0006-ml-delegation.md)）。
- **単一ユーザー・ローカル限定** — マルチユーザー / チーム共有 / サーバ集約はしません。
- **Web / モバイル UI なし** — 境界は CLI と MCP です。

## ステータス

開発初期 — **公開済み**（npm / 単一バイナリ / Docker）。仕様駆動で構築中です。

## インストール

Suasor は MCP サーバ（ライブラリではなく*アプリ*）なので、専用ランタイム **Bun** で動きます。Bun を使うかどうかでチャネルを選んでください。単一バイナリと Docker は **ランタイム不要**（Bun を内蔵）なので、Bun を使っていないなら最も簡単です。詳細: [docs/guide/install.md](docs/guide/install.md)。

- **単一バイナリ**（ランタイム不要） — OS/arch 別に [Releases](https://github.com/ozzy-labs/suasor/releases) からダウンロード。Bun を内蔵コンパイル済み。core + 少数 native のみで、重い connector SDK は external（全 connector は npm/Docker を利用）。
- **Docker（Ollama 同梱）**（ランタイム不要） — `docker run ghcr.io/ozzy-labs/suasor`。egress なしのローカル embedding。
- **npm（Bun ユーザー向け）** — `bunx @ozzylabs/suasor mcp serve`（または `bun add -g @ozzylabs/suasor`）。**Bun ≥ 1.2 が必要**（[Bun 導入](https://bun.sh)。`bun:sqlite` を使うため `npx`/Node 不可。pnpm/npm でも取得可だが実行は Bun）。OIDC publish（provenance 付き）。
- **MCP registry** — [`server.json`](server.json) で discovery 可能。

> npm / バイナリ / Docker で公開済み。コントリビュータは [ソースから](#ソースから) も実行できます。

## クイックスタート（暫定）

> 開発初期ですが、下記の CLI コマンドはすべて実装済みです（取り込み・検索・MCP server・skill すべて動作）。MCP surface も `brief` / `graph.related`・`graph.expand` を含めて提供済みです（[docs/design/mcp-surface.md](docs/design/mcp-surface.md) 参照）。

下記コマンドは、上記いずれかのチャネルで Suasor を**インストール済み**で `suasor` が `PATH` 上にあることを前提としています。インストール形態に合わせて読み替えてください:

| インストールチャネル | CLI の実行形 |
| --- | --- |
| 単一バイナリ | `suasor <cmd>` |
| npm（Bun ユーザー） | `suasor <cmd>`（グローバル導入）または `bunx @ozzylabs/suasor <cmd>` |
| Docker | `docker run --rm -v suasor-data:/data ghcr.io/ozzy-labs/suasor:latest <cmd>` |

以下の例は `suasor <cmd>` 形を使います。clone から動かす場合は [ソースから](#ソースから) を参照してください。

```bash
suasor --version

# 初回セットアップ: ~/.config/suasor/config.toml とローカル SQLite ストアを作成。
# 成功時にネクストステップ（doctor -> connector -> sync -> 定期実行 -> skills）を多段案内。
suasor init

# ガイド付きセットアップ: connector を選び、トークンを保存し、[connectors.X] config
# スライス（enabled = true）を組み、初回 sync を実行し、scheduler + MCP のスニペットを
# 出力 — すべて正しい順序で（ADR-0029）。
suasor onboard --connector github   # TTY では対話式・--json で要約出力

# 設定 / DB / connector の準備状況を確認（診断専用・何も作らない）。
suasor doctor

# コネクタから read 専用で取り込み（github / slack / ms-graph / google / box / web / local / notion / jira）。
suasor github sync

# あるいは有効な全 connector を 1 回の read 専用パスで一括取り込み（one-shot）。
suasor sync                   # --connector a,b / --json 利用可

# source 本文の全文検索（FTS5。--json / --limit 利用可）。
suasor search "<query>"

# 同梱のアシスタント skill をエージェントホストへ展開。
suasor skills install        # .claude/skills/ + .agents/skills/
suasor skills list           # installed / missing / modified

# メンテナンス。
suasor db migrate            # projection schema 適用（idempotent）
suasor projections rebuild   # event log を replay して projection 再構築
suasor export backup         # 一貫性のあるストアのバックアップ（--format sqlite|tgz）
suasor config edit           # config.toml を $EDITOR で編集・保存時に検証
suasor validate-config       # config.toml を検査（--fix で安全な修復を適用）
```

設定は `~/.config/suasor/`（`SUASOR_CONFIG_DIR` で上書き）に置かれます。`suasor config edit`（保存時に検証し、不正な編集はロールバック）で編集し、`suasor validate-config [--fix]` で検査できます。`<connector> sync` は github / slack / ms-graph / google / box / web / local / notion / jira から read 専用で取り込みます（各コネクタの設定は [docs/guide/connectors.md](docs/guide/connectors.md)）。ローカルストアは `suasor export backup` でバックアップし、取り込み済みデータの監査・削除は `suasor source list` / `suasor source forget` で行えます（[docs/guide/data-audit.md](docs/guide/data-audit.md)）。よくある失敗（空 sync・recall が空・dimension 不一致・rate limit）の診断は [docs/guide/troubleshooting.md](docs/guide/troubleshooting.md) を参照してください。コマンド・フラグの一覧は [docs/design/cli.md](docs/design/cli.md)、アシスタント skill は [docs/skills/README.md](docs/skills/README.md) を参照してください。

### ソースから

コントリビュータや clone から動かす場合は Bun を直接使います — 上記の各コマンドで `suasor` を `bun run src/index.ts` に置き換えてください。[Bun](https://bun.sh) 1.2+ が必要です。

```bash
git clone https://github.com/ozzy-labs/suasor.git
cd suasor
bun install                          # 依存インストール
bun run src/index.ts --version

bun run src/index.ts init            # `suasor init` と同じ初回セットアップ
bun run src/index.ts doctor          # `suasor doctor` と同じ診断
bun run src/index.ts sync            # `suasor sync` と同じ一括取り込み
```

`bun run dev` は `bun run src/index.ts` のショートハンドです。開発・検証フロー（`bun test` / `bun run typecheck` / lint）は [AGENTS.md](AGENTS.md) を参照してください。

### 定期 sync

`suasor sync` は有効な全 connector を 1 回の短命・冪等なパスで取り込みます（read 専用・continue-on-error・1 つでも失敗すれば exit 1）。Suasor は常駐デーモンを持たないため、定期実行は OS のスケジューラ（cron / launchd / systemd timer）で組みます:

```cron
# cron で毎時一括 sync。終了コードで成否を判定し、JSON 出力をログに残す。
15 * * * * suasor sync --json >> "$HOME/.local/state/suasor/sync.log" 2>&1
```

launchd / systemd timer の例と失敗監視は [docs/guide/scheduling.md](docs/guide/scheduling.md)（[ADR-0027](docs/adr/0027-bulk-sync-orchestration.md)）を参照してください。

## エージェントホストと接続する（MCP）

Suasor は記憶を AI エージェントへ [Model Context Protocol](https://modelcontextprotocol.io)（stdio transport）で公開します。この server がエージェント境界です。read tool は副作用なしで read-only annotation 付き（host が auto-approve 可）、write tool は HITL（人の承認）の後ろに置かれます（[ADR-0004](docs/adr/0004-mcp-agent-boundary-and-hitl.md)）— 承認なく適用・egress はしません。全体は [`src/mcp/tool-catalog.ts`](src/mcp/tool-catalog.ts) から生成しており、この一覧が drift しないようにしています（表記は英語）:

<!-- BEGIN GENERATED mcp-tools — source: src/mcp/tool-catalog.ts; regenerate with `bun run gen:readme-tools`. DO NOT EDIT BY HAND. -->

**Read tools** — side-effect-free (`readOnlyHint: true`), so hosts may auto-approve them:

- `search` — FTS5 full-text search over ingested sources.
- `recall.search` — Semantic (embedding) search; degrades to FTS when no backend is enabled.
- `search.hybrid` — Hybrid search: RRF fusion of FTS + semantic hits; degrades to FTS-only.
- `source.list` — List ingested sources newest-first.
- `source.get` — Fetch one source (with body) by id.
- `source.get.full` — Bundle a source's body + outgoing provenance links + extraction_meta in one call.
- `source.history` — List a source's body versions from the event log (newest first).
- `task.list` — List tasks, most-recently-updated first.
- `decision.list` — List recorded decisions, newest-recorded first.
- `demand.list` — List connector-neutral demand (Slack @mentions/DMs + github notifications); un-acked only by default (ADR-0041).
- `priority.list` — Deterministic cross-entity next-actions ranking (tasks + commitments + un-acked demand, ADR-0041).
- `brief` — Bundle the period's tasks/decisions/sources/inbox for the host to summarize.
- `sync.status` — Per-connector ingest freshness (latest run + ok/stale/never/failing verdict).
- `graph.related` — Provenance neighbours of an entity (1 hop) over the links projection.
- `graph.expand` — Breadth-first provenance expansion from an entity (N hops); direction in/out/both for backward trace.
- `activity.timeline` — Entity-axis merged source/task/decision timeline (newest-first) for one entity.
- `inbox.list` — List inbox items, most-recently-updated first.
- `propose.list` — List proposal candidates by state (pending/applied/rejected).
- `commitment.list` — List commitments by state (open/resolved/dismissed) and direction.
- `person.list` — List resolved persons with their connector author identities (ADR-0022).

**Write tools** — every one is HITL: a host must gate it behind human approval, and there is no auto-apply path ([ADR-0004](docs/adr/0004-mcp-agent-boundary-and-hitl.md)). The set includes **actuators** that carry out an approved action on your behalf — `task.publish` / `task.act` / `task.update` egress to your GitHub / Jira / Slack task home ([ADR-0036](docs/adr/0036-task-external-home.md)) — and `source.forget`, which irreversibly purges an ingested source. Suasor never triggers any of these on its own; you approve each one first:

- `connector.sync` — Run a read-only connector ingest pass into the local store.
- `propose.generate` — Frame reply/task/decision/triage candidates and record them as pending.
- `propose.apply` — Persist approved candidates as domain events (idempotent).
- `propose.reject` — Reject a pending candidate with a reason (idempotent).
- `proposal.feedback` — Record a regeneration hint on a pending candidate without applying/rejecting it.
- `propose.batch` — Apply and/or reject candidates in one atomic RPC (single transaction).
- `task.create` — Create a task directly (TaskProposed).
- `task.update` — Transition a task's lifecycle state (TaskApplied).
- `task.publish` — Publish a task to its external home (TaskPublished, egress).
- `task.act` — Act on a published task: complete/reopen/comment (TaskActionIssued).
- `decision.record` — Record a decision directly (DecisionRecorded).
- `inbox.add` — Capture an inbox item referencing a source (InboxItemTriaged, state open).
- `inbox.triage` — Resolve an open inbox item (task / decision / discard).
- `link.add` — Create a manual provenance link between two entities (LinkAdded, manual_link).
- `link.remove` — Remove a manual link by id (LinkRemoved).
- `person.merge` — Merge two persons into one (PersonsMerged); reversible via person.split.
- `person.split` — Split one identity off a person into another (PersonSplit).
- `commitment.resolve` — Mark an open commitment fulfilled (CommitmentResolved).
- `commitment.dismiss` — Dismiss an open commitment as a false-positive (CommitmentDismissed).
- `commitment.reopen` — Reopen a resolved/dismissed commitment back to open (CommitmentReopened).
- `demand.ack` — Mark a demand row handled — drops it from the un-acked demand.list (DemandAcknowledged).
- `demand.dismiss` — Mark a demand row not relevant — drops it from the un-acked demand.list (DemandDismissed).
- `draft.export` — Write a draft to a local file in the export sandbox (DraftExported).
- `source.forget` — Purge an ingested source locally — redact + delete + tombstone (SourceForgotten).
- `source.unforget` — Lift a forget tombstone so the source can be re-ingested (SourceUnforgotten).

<!-- END GENERATED mcp-tools -->

```bash
suasor mcp serve                 # MCP server を stdio で起動
# ソースから: bun run src/index.ts mcp serve
```

MCP host（Claude Code / Claude Desktop / Codex CLI 等）に登録します。Claude Desktop の場合は `claude_desktop_config.json` に以下を追加します（グローバル導入 `bun add -g @ozzylabs/suasor` で `suasor` が PATH 上にあり Bun で解決される前提）:

```jsonc
{
  "mcpServers": {
    "suasor": {
      "command": "suasor",
      "args": ["mcp", "serve"]
    }
  }
}
```

host に Bun が無い場合は、代わりに Docker イメージを指定します（ランタイム不要）:

```jsonc
{
  "mcpServers": {
    "suasor": {
      "command": "docker",
      "args": ["run", "--rm", "-i", "-v", "suasor-data:/data", "ghcr.io/ozzy-labs/suasor:latest"]
    }
  }
}
```

意味検索（`recall.search`）は embedding backend を有効にするまで `embedding_disabled` シグナルを返すため、host は FTS の `search` へ graceful にフォールバックできます（ADR-0005）。tool スキーマは [docs/design/mcp-surface.md](docs/design/mcp-surface.md) を参照してください。

## ライセンス

MIT
