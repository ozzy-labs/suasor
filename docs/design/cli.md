# CLI

clipanion ベース。lazy import で cold start を軽く保つ（[ADR-0001](../adr/0001-typescript-bun-stack.md) / NFR-PRF-1）。

## コマンド

```bash
suasor init [--force]                  # 設定 + DB 初期化 + ネクストステップ案内（skills install は別コマンド）
suasor onboard [--connector a,b] [--skip-auth] [--skip-sync] [--write-cron] [--json]  # 対話セットアップウィザード（connector 選択 → token 格納 → auth test → config slice 追記 → 初回 sync → scheduler/MCP 雛形・[ADR-0029]）
suasor db migrate [--vec]              # projection schema 適用（idempotent）
suasor projections rebuild             # event replay で projection 再構築
suasor <connector> sync [--full] [--json]  # 取り込み（github / slack / ms-graph / google / box / web / local）
suasor sync [--connector a,b] [--continue-on-error] [--full] [--json] [--no-progress]  # 有効 connector を一括取り込み（one-shot・定期実行は OS スケジューラへ委譲）
suasor <connector> auth set [--token T]  # connector の資格情報を OS keychain に保存（github / ms-graph / google / box、省略時 stdin）
suasor <connector> auth test [--json]    # 保存済み資格情報を検証 + identity + scopes（github / ms-graph / google / box）
suasor connectors list [--json]        # 登録 connector の enabled / token 設定有無を一覧（introspection）
suasor doctor [--json]                 # config/DB/embedding/connector を一括ヘルスチェック（error 検出で exit 1）
suasor config show [--effective] [--json]  # 実効 config（env > file > defaults の合成値）を表示。secret は常にマスク
suasor extraction status [--json]      # 文書抽出カバレッジ（extracted / stale / pending）+ backend / version
suasor embeddings status [--json]      # 埋め込みカバレッジ（entity 種別ごとの embedded / pending / stale）+ backend / model
suasor embeddings rebuild [--full] [--json]  # 現行 model と異なる/欠落 source を再埋め込み（--full は全件）
suasor embeddings drain [--json]       # pending（ベクトル未生成）の catch-up 再埋め込み
suasor embeddings find-duplicates [--threshold T] [--json]  # cosine 類似度が閾値超の near-dup ペア列挙
suasor search [--limit N] [--json] <query>  # FTS 検索
suasor brief [--since D] [--until ISO] [--limit N] [--json]  # 期間ダイジェスト（brief バンドル）を stdout 出力
suasor mcp serve                       # MCP server（stdio）起動（read tools）
suasor mcp tools [--json]              # MCP 登録ツールを server 起動せず一覧（name / read·write / 概要）
suasor slack auth set [--token T]      # Slack token を OS keychain に保存（省略時 stdin）
suasor slack auth test [--json]        # token 検証 + granted scopes + feature readiness
suasor slack conversations [--types T] [--include-archived] [--limit N] [--sort last_self_post] [--no-progress] [--json]  # 可視会話の列挙 + 設定ブロック出力
suasor slack status [--json]           # 保存中の resume cursor（workspace / channel）を表示（ts は人間可読列）
suasor slack cursor reset (--channel C1,C2 | --all) [--workspace A] [--yes]  # cursor を消し floor から取り直す
suasor slack cursor backfill --channel C1 --since 180d [--workspace A] [--yes]  # cursor を過去 floor へ下げ未取得分を取り直す
suasor skills install [--scope S] [--host DIR] [--dry-run]  # アシスタント skill 展開
suasor skills list [--scope S] [--host DIR] [--format F] [--json]  # アシスタント skill 状態一覧（detailed で category/境界併記）
suasor skills search <kw> [--json]                          # name/description/category/triggers 横断検索
suasor skills info <name> [--json]                          # 単一 skill の詳細（category/境界/triggers/pairs/MCP tools）
suasor --version                       # バージョン出力
```

実装状況: `init` / `onboard`（対話セットアップウィザード・既存 verb（auth set / auth test / sync）を正しい順序で繋ぎ `[connectors.X]` slice を非破壊で追記・[ADR-0029](../adr/0029-onboarding-wizard.md)） / `db migrate` / `projections rebuild` / `search` / `brief`（期間バンドルを非対話に stdout 出力・定期実行向け・[ADR-0017](../adr/0017-brief-period-bundle.md)） / `<connector> sync` / `<connector> auth set` / `<connector> auth test`（github / ms-graph / google / box の汎用 auth verb・[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) を Slack 以外へ拡張）/ `connectors list`（connector registry introspection・[ADR-0007](../adr/0007-connector-contract.md)）/ `doctor`（config/DB/embedding/connector の統合ヘルスチェック・診断）/ `config show`（実効 config の値確認・secret マスク・doctor と責務分離）/ `extraction status`（文書抽出カバレッジ・[ADR-0024](../adr/0024-document-extraction-sidecar.md)）/ `embeddings status` / `embeddings rebuild` / `embeddings drain` / `embeddings find-duplicates`（埋め込み層の保守 verb・[ADR-0006](../adr/0006-ml-delegation.md)）/ `mcp serve`（read tools・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）/ `mcp tools`（MCP tool surface introspection・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）/ `slack auth set` / `slack auth test` / `slack conversations`（Slack 運用 verb・[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)）/ `slack status` / `slack cursor reset` / `slack cursor backfill`（cursor 可視化・recovery・[ADR-0016](../adr/0016-slack-sync-date-floor.md)）/ `skills install` / `skills list`（アシスタント skill 展開・状態確認、[ADR-0008](../adr/0008-assistant-skills.md)）/ `skills search` / `skills info` / `skills list --format=detailed`（frontmatter 機械可読フィールドによる発見性、[ADR-0032](../adr/0032-skill-frontmatter-schema.md)）は稼働。
`<connector> sync` は connector registry から 1 connector = 1 command で派生する（[ADR-0007](../adr/0007-connector-contract.md)）。`sync`（全有効 connector の一括 one-shot 取り込み・[ADR-0027](../adr/0027-bulk-sync-orchestration.md)）も稼働。
稼働 connector: `github` / `slack` / `ms-graph`（Outlook / Calendar / OneDrive / Teams）/ `google`（Drive / Gmail / Calendar）/ `box` / `web`（Playwright snapshot）/ `local`（ローカル FS 走査・[ADR-0023](../adr/0023-local-filesystem-connectors.md)）。setup は [connectors guide](../guide/connectors.md)。

## フラグ（確定）

| コマンド | フラグ | 既定 | 意味 |
|---|---|---|---|
| `init` | `--force` | false | 既存 `config.toml` を default テンプレートで上書きする |
| `onboard` | `--connector a,b` | (TTY 時は対話) | セットアップ対象の connector 名カンマ列。非 TTY（パイプ / CI）では必須 |
| `onboard` | `--skip-auth` | false | keychain 格納 + auth test を skip（token は env override / binary 前提） |
| `onboard` | `--skip-sync` | false | 初回 `suasor sync` を skip |
| `onboard` | `--write-cron` | false | cron 行を crontab に追記する（既定は雛形を表示のみ） |
| `onboard` | `--json` | false | 各ステップ結果（auth / config 追記有無 / sync / scheduler 種別）を機械可読出力 |
| `db migrate` | `--vec` / `--no-vec` | true | sqlite-vec の vec0 substrate を作る／作らない |
| `search` | `--limit N` | 20 | 返す hit の最大数（正の整数。非正値は error） |
| `search` | `--json` | false | 人間可読リストの代わりに `SearchResult`（hits + strategy）を JSON で出力 |
| `brief` | `--since D` | `24h` | 期間下限。相対（`24h` / `7d` / `2w`）または ISO date。下限 inclusive |
| `brief` | `--until ISO` | now | 期間上限（exclusive）、ISO date/datetime |
| `brief` | `--limit N` | 50 | セクションごとの最大行数（正の整数。非正値は error） |
| `brief` | `--json` | false | 人間可読サマリの代わりに `Brief` バンドル全体を JSON で出力 |
| `<connector> sync` | `--full` | false | 保存済み cursor を無視して全件再スキャン |
| `<connector> sync` | `--json` | false | 件数 + cursor（`SyncOutcome`）を JSON で出力 |
| `<connector> sync` | `--no-progress` | false | 進捗表示を無効化（stderr が TTY でないとき自動 off） |
| `sync` | `--connector a,b` | all enabled | 一括対象を絞り込む connector 名のカンマ列（有効かつ登録済みのみ。非該当は error） |
| `sync` | `--continue-on-error` / `--no-continue-on-error` | true | 1 connector の失敗で全体を止めない（既定 on）。`--no-` で fail-fast（最初の失敗で停止）。いずれも失敗が 1 つでもあれば exit 1 |
| `sync` | `--full` | false | 各 connector の保存済み cursor を無視して全件再スキャン |
| `sync` | `--json` | false | connector ごとの件数・cursor・エラーを集約した `BulkSyncResult` を JSON 出力 |
| `sync` | `--no-progress` | false | 進捗表示を無効化（stderr が TTY でないとき自動 off） |
| `<connector> auth set` | `--token T` | stdin | 保存する資格情報値（省略時は stdin から読む）。github=PAT / ms-graph=client secret / google=refresh token / box=access token |
| `<connector> auth test` | `--json` | false | identity / scopes / features readiness を JSON で出力 |
| `connectors list` | `--json` | false | 人間可読リストの代わりに `{name, enabled, tokenConfigured}[]` を JSON で出力 |
| `doctor` | `--json` | false | 人間可読レポートの代わりに `{ok, checks: {name, status, detail}[]}` を JSON で出力 |
| `config show` | `--effective` | true | 合成後の実効値（env > file > defaults）を表示。将来 `--source` で由来表示を追加する余地を残す既定フラグ |
| `config show` | `--json` | false | 人間可読レポートの代わりに `{config, credentials}` を JSON で出力（secret はマスク済み） |
| `extraction status` | `--json` | false | 人間可読テーブルの代わりに `ExtractionStatus`（backend / version / totals）を JSON で出力 |
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
| `skills list` | `--format F` | compact | `compact`（status のみ・従来出力） \| `detailed`（category + read/write 境界を併記、[ADR-0032](../adr/0032-skill-frontmatter-schema.md)） |
| `skills list` | `--json` | false | 人間可読リストの代わりに `SkillStatus[]`（name / host / state / mirrorPath）を JSON で出力（shape 不変） |
| `skills search` | `<query>` | （必須） | name / description / category / triggers を横断する部分一致検索（[ADR-0032](../adr/0032-skill-frontmatter-schema.md)） |
| `skills search` | `--json` | false | ヒット skill を frontmatter フィールド + name の JSON 配列で出力 |
| `skills info` | `<name>` | （必須） | 単一 skill の category / 境界 / triggers / pairs / MCP tools / description を表示（未知 name は exit 1） |
| `skills info` | `--json` | false | frontmatter + name を JSON で出力 |

- `search <query>` は FTS-first（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）。trigram FTS5 を既定経路とし、3-gram に満たない短クエリ（日本語の 1–2 文字等）は LIKE substring fallback に切り替わる（[retrieval](retrieval.md)）。サービス本体は `src/retrieval/`
- `brief` は `brief` MCP tool（[ADR-0017](../adr/0017-brief-period-bundle.md)）と同じ `buildBrief` バンドル（tasks/decisions/sources/demand + open inbox）を **非対話に stdout 出力**する read CLI。対話エージェント不在の **定期実行**（cron / CI、knowledge `ai/practice` の「AI エージェント定期実行」）で日次/週次ダイジェストを出す用途。要約はプロセス外（`--json` を外部 summarizer にパイプ、ML 委譲 [ADR-0006](../adr/0006-ml-delegation.md)）。`--since` は相対（`24h`/`7d`/`2w`）または ISO、Slack demand の `selfUserIds` は `[connectors.slack]` config から解決する。サービス本体は `src/cli/commands/brief.ts`（query は `src/mcp/queries.ts` の `buildBrief` を流用）
- `<connector> sync` は `[embedding].backend` 有効時、新規 / 本文変更 source を埋め込んで vec0 に populate する（`SyncOutcome.embedded`、人間可読出力では `… , N embedded`）。embedding は best-effort でサイドカー失敗は warning（stderr）に留め取り込みは成功する（[embedding setup](../guide/embedding.md) / [retrieval](retrieval.md)）
- `<connector> sync` は `[extraction].backend` 有効時、新規 / 変更された Office/PDF（extractable）source の本文をサイドカー抽出テキストに差し替える（`SyncOutcome.extracted`、人間可読出力では `… , N extracted`、[ADR-0024](../adr/0024-document-extraction-sidecar.md)）。初期スコープは `local` connector。抽出も best-effort で unsupported / oversized / 失敗は warning（stderr）+ name-only fallback。**抽出を後から有効化した既存ファイル / `[extraction].version` を bump した場合は、内容未変更でも drift として次の `sync` で自動再抽出される**（`extraction_meta` に記録した version と現行 version の差分検知・ADR-0024 §6）。fingerprint はファイル実体ベースのままで差分検知に影響しない
- `extraction status` は文書抽出層（[ADR-0024](../adr/0024-document-extraction-sidecar.md)）のカバレッジを可視化する保守 verb。`extraction_meta` + `sources` から `extracted`（現 version で抽出済み）/ `stale`（別 version＝次 sync で再抽出）/ `pending`（extractable だが未試行）/ `unsupported` / `too-large` を集計し、backend / version を出す。read-only（SELECT のみ）。サービス本体は `src/extraction/maintenance.ts`
- `<connector> sync` は connector が内部に複数の取り込み単位を持つ場合の**部分失敗を `SyncOutcome.partialFailure` で報告**する（[ADR-0014](../adr/0014-slack-multi-workspace.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)）。Slack のマルチ workspace で一部 workspace だけ失敗した場合、取り込めた workspace のレコードは保持しつつ **exit 1** で終了し、`SyncOutcome.summaryLines`（workspace 別サマリ、例 `workspaces: acme=ok, beta=failed (cursor preserved), gamma=skipped (no token)`）を人間可読出力では `<connector>: <line>` として出す。これにより部分失敗が exit 0 に隠れず cron / CI で検知できる（従来は全 workspace 失敗時のみ exit 1）。`sync`（一括）経由でも部分失敗は connector 失敗として集計され全体 exit 1（後述）。全 connector 共通の汎用フィールドで、内部単位を持たない connector は `partialFailure=false` / `summaryLines` 省略
- `<connector> sync` 実行中は **stderr に進捗（処理件数）を表示**する（`src/cli/progress.ts`）。stdout / `--json` を汚さないよう stderr、かつ **TTY 限定**（CI / パイプ / リダイレクトでは自動的に無音）。`--no-progress` で明示無効化（opshub ADR-0026 相当）。`slack conversations` も同じ `createProgress` を使い、DM 名前解決ループ（`users.info`）と `--sort=last_self_post` の `search.messages` ページングを進捗表示でラップする（#84）
- `sync`（[ADR-0027](../adr/0027-bulk-sync-orchestration.md)・FR-ING-5/6）は**有効 connector を一括取り込み**する短命・冪等な one-shot。有効判定は `connectors list` / `doctor` と同一（`[connectors.<name>]` slice が存在し `enabled = false` でない）。各 connector は既存の共有 `syncConnector` サービスを直列で呼ぶ（CLI 単体 sync・`connector.sync` MCP tool と同一コードパス）。**continue-on-error**: 1 connector の失敗が全体を止めず、connector ごとの成否を集約し **1 つでも失敗があれば exit 1**（`doctor` の終了コード規約に整合、cron / CI が gate に使える）。`--connector a,b` で対象を絞り込む（有効かつ登録済みのみ。非該当は error）。`--json` は connector ごとの件数（`SyncOutcome`）・cursor・エラーを集約した `BulkSyncResult` を出す。embedder / extractor / progress は単体 sync と同じ best-effort 取り扱い。**定期実行は Suasor の責務とせず OS スケジューラ（cron / launchd / systemd timer）へ委譲**し、常駐 `--watch` は採らない（[ADR-0020](../adr/0020-multi-actor-coordination-scope.md) の単純性を維持）。範型は [scheduling guide](../guide/scheduling.md)。CLI 本体は `src/cli/commands/sync-all.ts`、orchestration サービスは `src/connectors/sync-all.ts`（`selectEnabledConnectors` / `runBulkSync`、import-clean）
- `<connector> auth set` / `<connector> auth test` は github / ms-graph / google / box の汎用 auth verb（Issue #85・[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) の運用 verb を Slack 以外へ拡張）。`auth set` は connector の primary secret（github=`token` / ms-graph=`clientSecret` / google=`refreshToken` / box=`token`）を keychain（service `suasor`、account `connector:<name>:<secret>`）へ保存（`storeSecret` 再利用、`config.toml` には書かない）。`auth test` は read-only の単発 round-trip で資格情報の有効性を検証し、identity・granted scopes（API が返す場合）・`features:` readiness（`READY` / `MISSING` / `N/A`）を出す。github=`GET /user`（`x-oauth-scopes`）/ ms-graph=client-credential token 交換 / google=refresh→access token 交換 / box=`GET /2.0/users/me`。いずれも connector SDK を読まず `fetch` のみ（import-clean、[ADR-0007](../adr/0007-connector-contract.md)）で token を error に出さない。Slack は scope readiness / マルチ workspace を持つ独自の `slack auth set/test` を維持。サービス本体は `src/connectors/<name>/auth.ts` + `src/connectors/auth-specs.ts`
- `slack status` / `slack conversations` は ts を人間可読に整形する（#84）。`slack status` の resume cursor と `slack conversations --sort=last_self_post` の engagement 列は raw epoch ではなく `YYYY-MM-DD HH:MM (<相対時刻>)` 形式で出す（`src/cli/slack-time.ts`、相対時刻はテストで `now` 注入により決定的）。**`--json` 出力は後方互換のため raw ts を維持**する
- `init` は config dir + default `config.toml`（欠落時のみ・既存は保持、`--force` で上書き）と local SQLite store を作る first-run setup。成功時に **主要ジャーニーをネクストステップとして多段案内**する: ① `suasor doctor` で設定/DB/接続を確認 → ② connector を設定（[connectors guide](../guide/connectors.md)）→ ③ `suasor sync` で初回取り込み → ④ 定期実行を OS スケジューラに登録（[scheduling guide](../guide/scheduling.md)）→ ⑤ 任意で `suasor skills install`・MCP 登録。案内のみで挙動は変えず（新コマンドは作らない・`doctor` は既存）、`--json` 等は持たない。サービス本体は `src/cli/commands/init.ts`
- `doctor` は config（`config.toml` の有無・ロード可否）/ database（`storage.dbPath` の存在・projection table 9 種の有無、**DB は作らない**＝診断専用）/ embedding（`[embedding].backend` 設定。`disabled` は INFO）/ connectors（enabled connector の資格情報設定有無、未設定は WARN。加えて **`auth set` 済みだが `[connectors.<name>]` を有効化していない** dangling credential も WARN で surface し、保存済み token に気づけるようにする・[#161](https://github.com/ozzy-labs/suasor/issues/161)。資格情報は存在有無のみ判定し値は出さない）を 1 コマンドで集約する診断 verb。`connectors list` / `embeddings status` / `db migrate` に分散していた health 情報を onboarding・サポート向けに一望にする。各 check は `ok` / `info` / `warn` / `error` を持ち、**1 つでも `error` があれば exit 1**（cron / CI が gate に使える）。秘密値は出さない（NFR-PRV-4）。サービス本体は `src/cli/commands/doctor.ts`
- `config show` は実効 config（`env override > file > defaults` を合成した値・[config design](config.md)）を表示する値確認 verb。`doctor` が「何が wired / missing か」の **健全性診断**なのに対し、`config show` は「今どの値が効いているか」の **値そのもの**を出す（責務分離）。CI / Docker / headless で実効値を確認するのに使う。secret は**常にマスク**（NFR-PRV-4）: token は `config.toml` に保存されない（keychain / env override・`src/connectors/secrets.ts`）ため合成 config に secret 値は載らないが、万一 secret 風キーが混入しても `***` でマスクする防御を入れ、connector の資格情報は**存在有無のみ**（`set` / `unset`、値は読まない）を別ブロックで出す。`--effective`（既定）は合成値を出し、将来 `--source` 等で由来表示を足す余地を残す。`--json` は `{config, credentials}` を出す。サービス本体は `src/cli/commands/config-show.ts`、masking ユーティリティは `src/config/mask.ts`
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
