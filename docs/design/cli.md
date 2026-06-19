# CLI

clipanion ベース。lazy import で cold start を軽く保つ（[ADR-0001](../adr/0001-typescript-bun-stack.md) / NFR-PRF-1）。

## コマンド

```bash
suasor init [--force]                  # 設定 + DB 初期化（skills install は別コマンド）
suasor db migrate [--vec]              # projection schema 適用（idempotent）
suasor projections rebuild             # event replay で projection 再構築
suasor <connector> sync [--full] [--json]  # 取り込み（github / slack / ms-graph / google / box / web / local）
suasor <connector> auth set [--token T]  # connector の資格情報を OS keychain に保存（github / ms-graph / google / box、省略時 stdin）
suasor <connector> auth test [--json]    # 保存済み資格情報を検証 + identity + scopes（github / ms-graph / google / box）
suasor connectors list [--json]        # 登録 connector の enabled / token 設定有無を一覧（introspection）
suasor embeddings status [--json]      # 埋め込みカバレッジ（entity 種別ごとの embedded / pending / stale）+ backend / model
suasor embeddings rebuild [--full] [--json]  # 現行 model と異なる/欠落 source を再埋め込み（--full は全件）
suasor embeddings drain [--json]       # pending（ベクトル未生成）の catch-up 再埋め込み
suasor embeddings find-duplicates [--threshold T] [--json]  # cosine 類似度が閾値超の near-dup ペア列挙
suasor search [--limit N] [--json] <query>  # FTS 検索
suasor mcp serve                       # MCP server（stdio）起動（read tools）
suasor mcp tools [--json]              # MCP 登録ツールを server 起動せず一覧（name / read·write / 概要）
suasor slack auth set [--token T]      # Slack token を OS keychain に保存（省略時 stdin）
suasor slack auth test [--json]        # token 検証 + granted scopes + feature readiness
suasor slack conversations [--types T] [--include-archived] [--limit N] [--sort last_self_post] [--no-progress] [--json]  # 可視会話の列挙 + 設定ブロック出力
suasor slack status [--json]           # 保存中の resume cursor（workspace / channel）を表示（ts は人間可読列）
suasor slack cursor reset (--channel C1,C2 | --all) [--workspace A] [--yes]  # cursor を消し floor から取り直す
suasor slack cursor backfill --channel C1 --since 180d [--workspace A] [--yes]  # cursor を過去 floor へ下げ未取得分を取り直す
suasor skills install [--scope S] [--host DIR] [--dry-run]  # アシスタント skill 展開
suasor skills list [--scope S] [--host DIR] [--json]        # アシスタント skill 状態一覧
suasor --version                       # バージョン出力
```

実装状況: `init` / `db migrate` / `projections rebuild` / `search` / `<connector> sync` / `<connector> auth set` / `<connector> auth test`（github / ms-graph / google / box の汎用 auth verb・[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) を Slack 以外へ拡張）/ `connectors list`（connector registry introspection・[ADR-0007](../adr/0007-connector-contract.md)）/ `embeddings status` / `embeddings rebuild` / `embeddings drain` / `embeddings find-duplicates`（埋め込み層の保守 verb・[ADR-0006](../adr/0006-ml-delegation.md)）/ `mcp serve`（read tools・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）/ `mcp tools`（MCP tool surface introspection・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）/ `slack auth set` / `slack auth test` / `slack conversations`（Slack 運用 verb・[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)）/ `slack status` / `slack cursor reset` / `slack cursor backfill`（cursor 可視化・recovery・[ADR-0016](../adr/0016-slack-sync-date-floor.md)）/ `skills install` / `skills list`（アシスタント skill 展開・状態確認、[ADR-0008](../adr/0008-assistant-skills.md)）は稼働。
`<connector> sync` は connector registry から 1 connector = 1 command で派生する（[ADR-0007](../adr/0007-connector-contract.md)）。
稼働 connector: `github` / `slack` / `ms-graph`（Outlook / Calendar / OneDrive / Teams）/ `google`（Drive / Gmail / Calendar）/ `box` / `web`（Playwright snapshot）/ `local`（ローカル FS 走査・[ADR-0023](../adr/0023-local-filesystem-connectors.md)）。setup は [connectors guide](../guide/connectors.md)。

## フラグ（確定）

| コマンド | フラグ | 既定 | 意味 |
|---|---|---|---|
| `init` | `--force` | false | 既存 `config.toml` を default テンプレートで上書きする |
| `db migrate` | `--vec` / `--no-vec` | true | sqlite-vec の vec0 substrate を作る／作らない |
| `search` | `--limit N` | 20 | 返す hit の最大数（正の整数。非正値は error） |
| `search` | `--json` | false | 人間可読リストの代わりに `SearchResult`（hits + strategy）を JSON で出力 |
| `<connector> sync` | `--full` | false | 保存済み cursor を無視して全件再スキャン |
| `<connector> sync` | `--json` | false | 件数 + cursor（`SyncOutcome`）を JSON で出力 |
| `<connector> sync` | `--no-progress` | false | 進捗表示を無効化（stderr が TTY でないとき自動 off） |
| `<connector> auth set` | `--token T` | stdin | 保存する資格情報値（省略時は stdin から読む）。github=PAT / ms-graph=client secret / google=refresh token / box=access token |
| `<connector> auth test` | `--json` | false | identity / scopes / features readiness を JSON で出力 |
| `connectors list` | `--json` | false | 人間可読リストの代わりに `{name, enabled, tokenConfigured}[]` を JSON で出力 |
| `embeddings status` | `--json` | false | 人間可読テーブルの代わりに `EmbeddingStatus`（backend / model / kinds / totals）を JSON で出力 |
| `embeddings rebuild` | `--full` | false | 記録 model に関わらず全 source を再埋め込み（既定は drift / 欠落のみ） |
| `embeddings rebuild` | `--json` | false | `{candidates, embedded}` を JSON で出力 |
| `embeddings drain` | `--json` | false | `{candidates, embedded}` を JSON で出力 |
| `embeddings find-duplicates` | `--threshold T` | 0.95 | near-dup 判定の cosine 類似度閾値（`(0, 1]`、範囲外は error） |
| `embeddings find-duplicates` | `--json` | false | `DuplicatePair[]`（`{a, b, similarity}`）を JSON で出力 |
| `mcp tools` | `--json` | false | 人間可読リストの代わりに `{name, readOnlyHint, summary}[]` を JSON で出力 |
| `slack auth set` | `--token T` | stdin | 保存する token 値（省略時は stdin から読む） |
| `slack auth set` / `auth test` / `conversations` | `--workspace A` | default | 対象 workspace alias（マルチ workspace 用、[ADR-0014](../adr/0014-slack-multi-workspace.md)）。secret account `connector:slack:<alias>:token` |
| `slack auth test` | `--json` | false | principal / team / scopes / features を JSON で出力 |
| `slack conversations` | `--types T` | all | 列挙する型のカンマ列 `public,private,im,mpim` |
| `slack conversations` | `--include-archived` | false | アーカイブ済み channel も含める |
| `slack conversations` | `--limit N` | none | 列挙する会話の最大数（正の整数） |
| `slack conversations` | `--sort last_self_post` | — | engagement 順（自分の最終投稿 ts）。User Token 専用、Bot は N/A degrade（[ADR-0013](../adr/0013-slack-engagement-axis.md)） |
| `slack conversations` | `--json` | false | 会話一覧 + teamId + missingScopes を JSON で出力（ts は raw 値維持） |
| `slack conversations` | `--no-progress` | false | 進捗インジケータを無効化（stderr が非 TTY のときは自動 off、#84） |
| `slack status` | `--json` | false | resume cursor map（alias→channel→ts）を JSON で出力（ts は raw 値維持） |
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
- `<connector> sync` 実行中は **stderr に進捗（処理件数）を表示**する（`src/cli/progress.ts`）。stdout / `--json` を汚さないよう stderr、かつ **TTY 限定**（CI / パイプ / リダイレクトでは自動的に無音）。`--no-progress` で明示無効化（opshub ADR-0026 相当）。`slack conversations` も同じ `createProgress` を使い、DM 名前解決ループ（`users.info`）と `--sort=last_self_post` の `search.messages` ページングを進捗表示でラップする（#84）
- `<connector> auth set` / `<connector> auth test` は github / ms-graph / google / box の汎用 auth verb（Issue #85・[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) の運用 verb を Slack 以外へ拡張）。`auth set` は connector の primary secret（github=`token` / ms-graph=`clientSecret` / google=`refreshToken` / box=`token`）を keychain（service `suasor`、account `connector:<name>:<secret>`）へ保存（`storeSecret` 再利用、`config.toml` には書かない）。`auth test` は read-only の単発 round-trip で資格情報の有効性を検証し、identity・granted scopes（API が返す場合）・`features:` readiness（`READY` / `MISSING` / `N/A`）を出す。github=`GET /user`（`x-oauth-scopes`）/ ms-graph=client-credential token 交換 / google=refresh→access token 交換 / box=`GET /2.0/users/me`。いずれも connector SDK を読まず `fetch` のみ（import-clean、[ADR-0007](../adr/0007-connector-contract.md)）で token を error に出さない。Slack は scope readiness / マルチ workspace を持つ独自の `slack auth set/test` を維持。サービス本体は `src/connectors/<name>/auth.ts` + `src/connectors/auth-specs.ts`
- `slack status` / `slack conversations` は ts を人間可読に整形する（#84）。`slack status` の resume cursor と `slack conversations --sort=last_self_post` の engagement 列は raw epoch ではなく `YYYY-MM-DD HH:MM (<相対時刻>)` 形式で出す（`src/cli/slack-time.ts`、相対時刻はテストで `now` 注入により決定的）。**`--json` 出力は後方互換のため raw ts を維持**する
- `connectors list` は connector registry（[ADR-0007](../adr/0007-connector-contract.md)、`<connector> sync` の派生元）を起動なしで introspect する。各 connector の `enabled`（`[connectors.<name>]` slice が存在し `enabled = false` でない）と token 設定有無（`resolveSecret` で env override → keychain を確認、**値は出さない**・NFR-PRV-4）を返す。auth 不要な connector（`web`）は token を `n/a`（JSON は `tokenConfigured: null`）。connector ごとの secret 名は registry の `SECRET_NAMES`（`src/connectors/registry.ts`）が SSOT。サービス本体は `src/cli/commands/connectors-list.ts`
- `embeddings status` / `embeddings rebuild` / `embeddings drain` / `embeddings find-duplicates` は任意の埋め込み層（[ADR-0006](../adr/0006-ml-delegation.md)・[embedding setup](../guide/embedding.md)）を運用者から可視化・修復する保守 verb（#87）。`status` は entity 種別（`sources.source_type`）ごとに embedded / pending（ベクトル未生成）/ stale（別 model で生成済み）を集計し、有効 backend / model を出す。`rebuild` は記録 model（`embeddings_meta` サイドカー）が現行 `[embedding].model`（+ version）と異なる/欠落の source を再埋め込み（`--full` は全件）、`drain` はベクトル未生成の pending のみ catch-up、`find-duplicates` は vec0 のベクトル間 cosine 類似度が閾値超のペアを列挙する。いずれも `[embedding].backend` 無効時は明示メッセージで no-op 終了。`rebuild` / `drain` の埋め込みは best-effort でサイドカー失敗は warning（stderr）に留める（ingest と同じ degrade、[ADR-0006](../adr/0006-ml-delegation.md)）。ML はサイドカーへ委譲し本体は SQL + thin embedder client のみ（vec0 + `embeddings_meta` サイドカーは event ではない派生 substrate・[ADR-0002](../adr/0002-event-sourced-architecture.md)）。サービス本体は `src/retrieval/embedding/maintenance.ts`
- `mcp tools` は MCP tool surface（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)、[mcp-surface](mcp-surface.md)）を **server を起動せず**列挙する。各ツールの read/write 区分（`readOnlyHint`）と概要を出す。カタログは `src/mcp/tool-catalog.ts` をデータの SSOT とし、`tests/mcp/tool-catalog.test.ts` が実際に登録される server の tool（name / readOnlyHint）と突き合わせて drift を防ぐ。サービス本体は `src/cli/commands/mcp-tools.ts`
- `slack auth set` / `slack auth test` / `slack conversations` は Slack 固有の運用 verb（[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)）。汎用 connector 契約（`sync` のみ）は太らせず、token 保存（keychain）・scope 検証・会話 id 発見を担う。いずれも Slack SDK を読まず `fetch` のみ（import-clean）。`auth test` は `auth.test` 1 回で granted scopes（`x-oauth-scopes`）と feature readiness（`READY` / `READY (degraded)` / `MISSING <scope>` / `N/A`）を出す。readiness は scope 層のみで channel membership は保証しない。`conversations` は型ごとに `missing_scope` を自己申告し、`config.toml` に貼れる `[connectors.slack]` ブロックを出力する。サービス本体は `src/connectors/slack/`
- `skills install` は SSOT `docs/skills/<name>/SKILL.md`（パッケージ同梱）を `<host>/.claude/skills/<name>/SKILL.md` / `<host>/.agents/skills/<name>/SKILL.md` に展開する（[ADR-0008](../adr/0008-assistant-skills.md)）。冪等で、内容一致は `unchanged`・欠落は `created`・差分は SSOT で `updated`。エコシステム共通 dev skill（`@ozzylabs/skills`）は名前空間 disjoint で touch しない。サービス本体は `src/skills/`
- `skills list` は host dir ごとに各 skill を `installed`（SSOT と一致）/ `missing`（未展開）/ `modified`（展開済みだが SSOT と差分）で報告する。in-repo dogfood の mirror（`.claude/skills/` / `.agents/skills/`）と SSOT の同期は lefthook の `skills-drift` フック（`scripts/skills-drift.sh`）が pre-commit で検査する
- 長時間コマンド（sync / rebuild）の TTY 進捗表示（`--progress` / env 上書き）は connector 実装 Issue で確定

## 規約

- 各 subcommand は `execute` 内 lazy import で重い依存（DB 層 / config loader / connector）を遅延ロードする。
  registration（command クラスの登録）だけが eager。command module の top-level import は clipanion + 標準
  ライブラリに限定し、`tests/cli/lazy-import.test.ts` がこの discipline を静的・動的の両面で検証する
- `python -m` 相当は不要（Bun 実行 / 単一バイナリ）。`suasor --version` は entry の `binaryVersion`（`src/version.ts`）から
