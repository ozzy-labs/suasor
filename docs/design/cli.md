# CLI

clipanion ベース。lazy import で cold start を軽く保つ（[ADR-0001](../adr/0001-typescript-bun-stack.md) / NFR-PRF-1）。

## コマンド

```bash
suasor init [--force]                  # 設定 + DB 初期化（skills install は別コマンド）
suasor db migrate [--vec]              # projection schema 適用（idempotent）
suasor projections rebuild             # event replay で projection 再構築
suasor <connector> sync [--full] [--json]  # 取り込み（github / slack / ms-graph / google / box / web）
suasor search [--limit N] [--json] <query>  # FTS 検索
suasor mcp serve                       # MCP server（stdio）起動（read tools）
suasor slack auth set [--token T]      # Slack token を OS keychain に保存（省略時 stdin）
suasor slack auth test [--json]        # token 検証 + granted scopes + feature readiness
suasor slack conversations [--types T] [--include-archived] [--limit N] [--sort last_self_post] [--json]  # 可視会話の列挙 + 設定ブロック出力
suasor slack status [--json]           # 保存中の resume cursor（workspace / channel）を表示
suasor slack cursor reset (--channel C1,C2 | --all) [--workspace A] [--yes]  # cursor を消し floor から取り直す
suasor slack cursor backfill --channel C1 --since 180d [--workspace A] [--yes]  # cursor を過去 floor へ下げ未取得分を取り直す
suasor skills install [--scope S] [--host DIR] [--dry-run]  # アシスタント skill 展開
suasor skills list [--scope S] [--host DIR] [--json]        # アシスタント skill 状態一覧
suasor --version                       # バージョン出力
```

実装状況: `init` / `db migrate` / `projections rebuild` / `search` / `<connector> sync` / `mcp serve`（read tools・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）/ `slack auth set` / `slack auth test` / `slack conversations`（Slack 運用 verb・[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)）/ `slack status` / `slack cursor reset` / `slack cursor backfill`（cursor 可視化・recovery・[ADR-0016](../adr/0016-slack-sync-date-floor.md)）/ `skills install` / `skills list`（アシスタント skill 展開・状態確認、[ADR-0008](../adr/0008-assistant-skills.md)）は稼働。
`<connector> sync` は connector registry から 1 connector = 1 command で派生する（[ADR-0007](../adr/0007-connector-contract.md)）。
稼働 connector: `github` / `slack` / `ms-graph`（Outlook / Calendar / OneDrive / Teams）/ `google`（Drive / Gmail / Calendar）/ `box` / `web`（Playwright snapshot）。setup は [connectors guide](../guide/connectors.md)。

## フラグ（確定）

| コマンド | フラグ | 既定 | 意味 |
|---|---|---|---|
| `init` | `--force` | false | 既存 `config.toml` を default テンプレートで上書きする |
| `db migrate` | `--vec` / `--no-vec` | true | sqlite-vec の vec0 substrate を作る／作らない |
| `search` | `--limit N` | 20 | 返す hit の最大数（正の整数。非正値は error） |
| `search` | `--json` | false | 人間可読リストの代わりに `SearchResult`（hits + strategy）を JSON で出力 |
| `<connector> sync` | `--full` | false | 保存済み cursor を無視して全件再スキャン |
| `<connector> sync` | `--json` | false | 件数 + cursor（`SyncOutcome`）を JSON で出力 |
| `slack auth set` | `--token T` | stdin | 保存する token 値（省略時は stdin から読む） |
| `slack auth set` / `auth test` / `conversations` | `--workspace A` | default | 対象 workspace alias（マルチ workspace 用、[ADR-0014](../adr/0014-slack-multi-workspace.md)）。secret account `connector:slack:<alias>:token` |
| `slack auth test` | `--json` | false | principal / team / scopes / features を JSON で出力 |
| `slack conversations` | `--types T` | all | 列挙する型のカンマ列 `public,private,im,mpim` |
| `slack conversations` | `--include-archived` | false | アーカイブ済み channel も含める |
| `slack conversations` | `--limit N` | none | 列挙する会話の最大数（正の整数） |
| `slack conversations` | `--sort last_self_post` | — | engagement 順（自分の最終投稿 ts）。User Token 専用、Bot は N/A degrade（[ADR-0013](../adr/0013-slack-engagement-axis.md)） |
| `slack conversations` | `--json` | false | 会話一覧 + teamId + missingScopes を JSON で出力 |
| `slack status` | `--json` | false | resume cursor map（alias→channel→ts）を JSON で出力 |
| `slack cursor reset` | `--channel C1,C2` | — | reset 対象 channel id（カンマ列）。`--all` と排他 |
| `slack cursor reset` | `--all` | false | 全 channel（`--workspace` 指定時はその alias）を reset |
| `slack cursor reset` | `--yes` | false | 実適用（無指定は preview のみ） |
| `slack cursor backfill` | `--channel C1` / `--since 180d` | — | 指定 channel の cursor を `--since` floor（過去）へ下げる（#57） |
| `slack cursor backfill` | `--yes` | false | 実適用（無指定は preview のみ） |
| `skills install` | `--scope S` | all | 展開先 `claude`（`.claude/skills/`） \| `agents`（`.agents/skills/`） \| `all` |
| `skills install` | `--host DIR` | cwd | 展開先のベースディレクトリ（プロジェクトルート） |
| `skills install` | `--dry-run` | false | 書き込まず変更内容（created / updated / unchanged）だけ表示 |
| `skills list` | `--scope S` | all | 状態を確認する展開先 |
| `skills list` | `--host DIR` | cwd | 状態を確認するベースディレクトリ |
| `skills list` | `--json` | false | 人間可読リストの代わりに `SkillStatus[]`（name / host / state / mirrorPath）を JSON で出力 |

- `search <query>` は FTS-first（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）。trigram FTS5 を既定経路とし、3-gram に満たない短クエリ（日本語の 1–2 文字等）は LIKE substring fallback に切り替わる（[retrieval](retrieval.md)）。サービス本体は `src/retrieval/`
- `<connector> sync` は `[embedding].backend` 有効時、新規 / 本文変更 source を埋め込んで vec0 に populate する（`SyncOutcome.embedded`、人間可読出力では `… , N embedded`）。embedding は best-effort でサイドカー失敗は warning（stderr）に留め取り込みは成功する（[embedding setup](../guide/embedding.md) / [retrieval](retrieval.md)）
- `slack auth set` / `slack auth test` / `slack conversations` は Slack 固有の運用 verb（[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)）。汎用 connector 契約（`sync` のみ）は太らせず、token 保存（keychain）・scope 検証・会話 id 発見を担う。いずれも Slack SDK を読まず `fetch` のみ（import-clean）。`auth test` は `auth.test` 1 回で granted scopes（`x-oauth-scopes`）と feature readiness（`READY` / `READY (degraded)` / `MISSING <scope>` / `N/A`）を出す。readiness は scope 層のみで channel membership は保証しない。`conversations` は型ごとに `missing_scope` を自己申告し、`config.toml` に貼れる `[connectors.slack]` ブロックを出力する。サービス本体は `src/connectors/slack/`
- `skills install` は SSOT `docs/skills/<name>/SKILL.md`（パッケージ同梱）を `<host>/.claude/skills/<name>/SKILL.md` / `<host>/.agents/skills/<name>/SKILL.md` に展開する（[ADR-0008](../adr/0008-assistant-skills.md)）。冪等で、内容一致は `unchanged`・欠落は `created`・差分は SSOT で `updated`。エコシステム共通 dev skill（`@ozzylabs/skills`）は名前空間 disjoint で touch しない。サービス本体は `src/skills/`
- `skills list` は host dir ごとに各 skill を `installed`（SSOT と一致）/ `missing`（未展開）/ `modified`（展開済みだが SSOT と差分）で報告する。in-repo dogfood の mirror（`.claude/skills/` / `.agents/skills/`）と SSOT の同期は lefthook の `skills-drift` フック（`scripts/skills-drift.sh`）が pre-commit で検査する
- 長時間コマンド（sync / rebuild）の TTY 進捗表示（`--progress` / env 上書き）は connector 実装 Issue で確定

## 規約

- 各 subcommand は `execute` 内 lazy import で重い依存（DB 層 / config loader / connector）を遅延ロードする。
  registration（command クラスの登録）だけが eager。command module の top-level import は clipanion + 標準
  ライブラリに限定し、`tests/cli/lazy-import.test.ts` がこの discipline を静的・動的の両面で検証する
- `python -m` 相当は不要（Bun 実行 / 単一バイナリ）。`suasor --version` は entry の `binaryVersion`（`src/version.ts`）から
