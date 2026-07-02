# Connectors

Connector はソースから **read 専用**で取り込む共通実装（[ADR-0007](../adr/0007-connector-contract.md) / [connector-contract](../design/connector-contract.md)）。取り込みは event として append され、本文はローカル projection に保持され、FTS 検索の対象になる（[ADR-0002](../adr/0002-event-sourced-architecture.md) / [ADR-0003](../adr/0003-local-first-and-content-minimization.md)）。

取り込みの起動経路は 2 つ。どちらも同一の sync service を呼ぶ:

- CLI: `suasor <connector> sync`
- MCP write tool: `connector.sync`（HITL。人の承認なしに実行しない。[mcp-surface](../design/mcp-surface.md)）

## 空構成（no-op config）は sync 前に warn される

connector が **有効**（`[connectors.X]` があり `enabled = false` でない）でも、取り込み対象が空（github が `repos` 未設定かつ `notifications = "off"`、box が `folders` 未設定、local が `roots` 未設定、web が `urls` 未設定、google / ms-graph が **明示的に** `resources = []` を書いた場合、notion が `databases` 未設定かつ `pages = false`、jira が `projects` 未設定かつ `jql` 未設定、slack がどの workspace も `channels` 未設定）だと sync は黙って 0 件で終わり、DB を覗くまで気づけない（[#187](https://github.com/ozzy-labs/suasor/issues/187)）。これを防ぐため、sync は実行前に空構成を検出して stderr に warning を出す（例: `warning: github: repos 未設定かつ notifications=off — 取り込み対象なし（config の repos を設定するか notifications を all/repos に）`）。

- 単体 sync（`suasor <connector> sync`）と一括 sync（`suasor sync`、[ADR-0027](../adr/0027-bulk-sync-orchestration.md)）の両経路で同じ warning が出る
- **warn 止まり**で exit code は変えない（空構成は失敗ではない。`0 observed` で正常終了する）

## まず `suasor onboard`（推奨セットアップ導線）

connector を 1 つずつ手で設定する前に、対話ウィザード **`suasor onboard`** を使うと正しい順序（connector 選択 → token 格納 → `auth test` 疎通 → `[connectors.X]` slice 追記 → 初回 sync → スケジューラ雛形 → MCP 登録）を 1 コマンドで繋げる（[ADR-0029](../adr/0029-onboarding-wizard.md)）。

とりわけ **token を `auth set` で保存しても `[connectors.X] enabled=true` を書き忘れて `suasor sync` が無音で何もしない** という頻発ポイントを構造的に解消する（config slice の追記まで自動化する。既存セクションは非破壊）。

```bash
suasor onboard --connector github            # 対話（TTY）。token は stdin から
suasor onboard --connector github,slack --json   # 非対話・機械可読サマリ
suasor onboard --connector box --skip-auth   # token は env override 前提（headless / binary）
```

- **非対話端末**（パイプ / CI）では `--connector` が必須（プロンプトを出さない。"no silent wrong answer"）
- token は keychain に格納し、`config.toml` には書かない（secret は keychain / env override、NFR-PRV-4）
- config への追記は**末尾 append のみ**で既存の手書きコメント・他セクションを壊さない。既に `[connectors.X]` がある（`enabled = false` を含む）場合は触らない（冪等）

### discovery 連携（非 Slack connector の id 自動発見、[ADR-0030](../adr/0030-connector-discovery-verbs.md) / #195）

discovery verb を持つ connector（**github** = `repos` / **google** = `calendars` / **box** = `folders` / **notion** = `databases` / **jira** = `projects`）を onboard すると、ウィザードは `auth test` 後にその discovery probe を実行し、token から見える id を列挙して `[connectors.X]` ブロック（`repos = [...]` 等の id 配列入り）を生成し、そのまま非破壊追記する。`config.toml` に `enabled = true` だけでなく**取り込み対象 id まで**が入るため、id を手探りせず（typo による silent 0 件を回避して）setup が完結する。

- discovery 対応 connector で **token が解決できる**（keychain / env override）場合 → discovery を実行し、発見した id 入りブロックを追記（`--json` の `configSource` は `"discovery"`、`discovered` に件数）
- discovery 対応でも **token が無い / probe が失敗した**場合 → 最小の雛形 slice（必須キーはコメント雛形）を追記してフォールバックし、理由を stderr に表示（`configSource` は `"template"`）。あとで `suasor <connector> <verb>` を手で実行して貼り替えればよい
- **discovery 非対応 connector**（slack / ms-graph / web / local）→ 従来どおり雛形コメント付き slice を追記（`configSource` は `"template"`）
- 既存 slice がある場合は discovery を実行せず非破壊で温存する（`configSource` は `"skipped"`）

```bash
# token を env override で渡し、github repos を discovery して config に貼る（headless）
SUASOR_CONNECTOR_GITHUB_TOKEN=ghp_xxx suasor onboard --connector github --skip-auth --json
```

以降の各 connector 節は、ウィザードを使わず手で設定する場合の詳細（token 種別・必須 config キー）を示す。

## GitHub

GitHub の issue / pull request を取り込む（`octokit`）。

### 1. トークンの用意

GitHub の Personal Access Token（fine-grained 推奨、対象リポジトリの **Issues: read-only** / **Pull requests: read-only** 権限）を発行する。

トークンは 2 経路で渡せる（**config.toml には書かない**）。優先順位は env override > keychain（[config](../design/config.md) / NFR-PRV-4）:

- **OS keychain**（既定・推奨）: service `suasor` / account `connector:github:token` に格納
- **env override**（headless / Docker 用）: `SUASOR_CONNECTOR_GITHUB_TOKEN`

```bash
# env override の例
export SUASOR_CONNECTOR_GITHUB_TOKEN="github_pat_..."
```

keychain への格納と検証は専用 CLI で行う（Issue #85・[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) の運用 verb を Slack 以外へ拡張）:

```bash
suasor github auth set                 # PAT を keychain に保存（stdin / --token）
suasor github auth test                # PAT 検証 + login + granted scopes + feature readiness
```

`auth set` は token を `connector:github:token`（service `suasor`）へ保存する（`storeSecret` 再利用・`config.toml` には書かない）。`auth test` は `GET /user` 1 回で login と granted scopes（`x-oauth-scopes`）を検証する（read-only、token を error に出さない、octokit も読まず `fetch` のみ）。env override（`SUASOR_CONNECTOR_GITHUB_TOKEN`）でも引き続き渡せる。

`auth test` は granted scopes から機能別 readiness（`features:` ブロック）を Slack と同じ書式で出す（Issue #194・[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)）。github は `issue / pull request read`（`repo` scope）と、`notifications != "off"` の場合のみ `notifications stream`（`notifications` または `repo` scope）を判定する。fine-grained PAT は `x-oauth-scopes` を返さない（scope 非列挙）ため各行は `N/A (scopes not enumerated)`（`GET /user` 疎通で有効性は確認済み）:

```text
ok: github credential for octocat
scopes: repo, read:org, notifications
features:
  issue / pull request read: READY
  notifications stream: READY
```

### 2. 対象リポジトリの発見（discovery）

`repos` に書く `owner/repo` を Web UI から手写しすると typo で sync が **silent に 0 件**になりやすい（[ADR-0007](../adr/0007-connector-contract.md) の「no silent wrong answer」に反する）。token から可視リポジトリを列挙して貼れる discovery verb を使う（Slack の `slack conversations` 相当・[ADR-0030](../adr/0030-connector-discovery-verbs.md)）:

```bash
suasor github repos                    # 可視リポジトリを列挙し [connectors.github] ブロックを出力
suasor github repos --filter acme      # full_name の部分一致（case-insensitive）で絞る
suasor github repos --json             # items + configBlock を JSON 出力
```

`GET /user/repos`（Link header ページング）を `fetch` のみ（octokit 非依存・import-clean、[ADR-0007](../adr/0007-connector-contract.md)）で列挙し、`owner/repo` / visibility（public/private）/ archived を出す。出力末尾の paste-ready な `[connectors.github]` ブロックをそのまま config.toml に貼れる（`repos` は **full name** で、各行の `#` コメントは visibility ラベル）。token は keychain + env override（`auth set` と同じ `token`）で解決し、error に出さない。

### 3. 対象リポジトリの設定

`~/.config/suasor/config.toml`（`SUASOR_CONFIG_DIR` で上書き）に `[connectors.github]` を追加する（上記 `github repos` の出力を貼り付け、`state` / `notifications` を調整する）:

```toml
[connectors.github]
repos = ["owner/repo", "owner/another-repo"]  # 取り込み対象（github repos で発見）
state = "all"                                  # open | closed | all（既定 all）
notifications = "off"                          # off | all | repos（既定 off）
# baseUrl = "https://github.example.com/api/v3"  # GitHub Enterprise の場合
```

`repos` が空かつ `notifications = "off"` の場合は何も取り込まない（トークンも要求しない）。

#### notifications（per-token 通知 stream）

`notifications` を有効にすると、`GET /notifications`（自分宛の mention / review request / assign 等の personal stream）を取り込む（Issue #93）。これは **repo 単位ではなく token 単位**の stream で、`repos` allowlist とは別軸の cursor を持つ。read-only（thread list を読むだけで既読化しない）。

- `off`（既定）: 取り込まない（既存の issue / PR のみ挙動を維持）
- `all`: 通知された全 repo を取り込む（`repos` に無い repo の通知も入る）
- `repos`: `repos` allowlist に含まれる repo の通知のみ取り込む（フィルタ out された thread も cursor は前進し、次回の再 flood を防ぐ）

`notifications = "all"` は `repos` が空でも単独で機能する（token の通知 stream のみ取り込む）。通知に必要な PAT scope: classic は `notifications`（または `repo`）、fine-grained は対象 repo の **Notifications: read-only**。Slack の `slack.demand.list` と同様、github notifications も将来 demand 系 MCP tool の入力になり得る demand signal。

### 4. 取り込みの実行

```bash
suasor github sync            # 差分取り込み（前回の cursor から resume）
suasor github sync --full     # cursor を無視して全件再スキャン
suasor github sync --json     # 件数 + cursor を JSON 出力
```

出力例:

```text
github sync: 12 observed, 3 updated, 5 unchanged.
```

- **identity**: source の `external_id` は `gh:<owner>/<repo>:issue:<number>` / `gh:<owner>/<repo>:pull_request:<number>`。notifications は token 単位のため repo prefix を持たず `gh:notification:<thread-id>`（いずれもソース横断で一意）
- **source_type**: `github_issue` / `github_pull_request` / `github_notification`
- **差分検知**（FR-ING-3）: issues の `since` cursor（delta API）で更新分のみ取得し、本文 fingerprint で未変更を skip。notifications は **token 軸の独立した `since` cursor** を持ち、issues 軸とは別に前進する（cursor は `{ issues, notifications }` の JSON map で保存。旧来の bare-string cursor は issues floor として後方互換解釈）。再実行は冪等（未変更ソースは更新イベントを生まない）

### 5. 検索

取り込んだ本文（タイトル + 本文）は即座に FTS 検索の対象になる:

```bash
suasor search rocket
```

MCP 経由では `search` read tool で同じ検索ができる（[retrieval](../design/retrieval.md)）。embedding backend を有効にすると、取り込み時に本文が埋め込まれ `recall.search` の意味検索（言語跨ぎ・語彙ミスマッチ向け）も使える（[embedding setup](embedding.md)）。

すべての connector で取り込み・検索・delta 検知・secret 経路（env override > keychain）の挙動は同一。以下は各 connector 固有の token / config slice のみ記す。token は **config.toml には書かない**（env override か keychain）。

## per-resource エラー分離（github / google / box / ms-graph / notion / jira）

複数リソース（github=repo / google=resource family / box=folder / ms-graph=resource family / notion=database + pages / jira=project）を 1 pass で走査する connector は、**1 リソースの失敗が他リソースの取り込みを巻き添えにしない**（[ADR-0014](../adr/0014-slack-multi-workspace.md) の per-workspace エラー分離を Slack 以外へ一般化、[#193](https://github.com/ozzy-labs/suasor/issues/193)）。従来は 1 repo の `403` が同 pass の他 repo の取り込みも止めていた。

- **失敗リソースは skip して continue**：fetch 途中で失敗したリソースは warning に集約し、残りのリソースの取り込みは止めない。
- **warn は 1 本に集約**：`github: 2 repo OK, 1 failed (cursor preserved) — owner/x (403)` の形式で、どのリソースがなぜ失敗したかを明示する（kind は connector ごとに `repo`（github）/ `resource`（google / ms-graph）/ `folder`（box）/ `project`（jira）/ `database`（notion））。
- **cursor 非リセット**：失敗リソースの prior cursor は保持する（reset しない）。github は **共有 `since` cursor を失敗 repo の最新 `updated_at` まで前進させない**ため、失敗 repo の gap が次回 silent に skip されない（成功 repo のみが共有 floor を前進させる）。google / box / ms-graph は fingerprint ベース（cursor `null`）なので前進そのものが無く、次回再走査で復旧する。
- **全リソース失敗時のみ throw**：すべてのリソースが失敗した pass は「無音の空成功」ではなく **error** として終了する（最後のエラーを再 throw）。
- **部分失敗の exit code + サマリ**：一部だけ失敗した部分失敗は `partialFailure` を立て、sync 末尾に **リソース別サマリ行**（例: `repos: owner/a=ok, owner/b=failed (cursor preserved)`）を 1 本出し、cron / CI が exit code を gate に検知できるよう **exit 1** で終了する（取り込めたリソースのレコードは保持される、[ADR-0027](../adr/0027-bulk-sync-orchestration.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)）。Slack の per-workspace 分離と同じセマンティクス。

token を持つ connector（github / ms-graph / google / box / notion / jira）は、汎用の `auth set` / `auth test` verb で keychain への保存と検証ができる（Issue #85）。`suasor <connector> auth set`（stdin / `--token` で primary secret を keychain に保存）/ `suasor <connector> auth test`（資格情報の有効性を read-only round-trip で検証し identity・granted scopes・readiness を出力）。各 connector が読む primary secret は github=`token` / ms-graph=`clientSecret` / google=`refreshToken` / box=`token` / notion=`token` / jira=`token`。Slack は scope readiness とマルチ workspace を持つ独自の `slack auth set/test`（後述）を維持する。

## Slack

channel メッセージを取り込む（`@slack/web-api`）。

### Slack App を作って token を発行する（3 ステップ）

Slack の token は **Slack App をインストールして発行**する。必要 scope を取りこぼすと `sync` が無音でゼロ件取り込みになりやすいので、同梱の **App manifest** から作るのが確実（manifest が必要 scope を全部含む）。

同梱の manifest: [`slack-app-manifest.yaml`](slack-app-manifest.yaml)（scope SSOT は [`src/connectors/slack/scopes.ts`](../../src/connectors/slack/scopes.ts) の `FEATURE_SCOPES`。drift は `tests/connectors/slack/manifest.test.ts` が検証＝scopes.ts に feature scope を足すと manifest 更新まで test が落ちる。二重 SSOT を作らない）。

1. **manifest を貼って App を作る** — [api.slack.com/apps](https://api.slack.com/apps) →「Create New App」→「From an app manifest」で対象 workspace を選び、[`slack-app-manifest.yaml`](slack-app-manifest.yaml) の中身を貼って作成 →「Install to Workspace」で承認する。
2. **Bot Token をコピーする** — App の「OAuth & Permissions」ページで **Bot User OAuth Token**（`xoxb-…`）をコピーする。engagement axis（`search:read`・User Token 専用）も使うなら **User OAuth Token**（`xoxp-…`）を併せてコピーする（manifest の `oauth_config.scopes.user` を残した場合のみ表示される）。
3. **`suasor slack auth set` で保存する** — コピーした token を keychain に保存して疎通を確認する:

```bash
suasor slack auth set    # token を stdin / --token で keychain に保存
suasor slack auth test   # 検証 + granted scopes + feature readiness を表示
```

`auth test` の readiness が `READY` 系なら scope は揃っている（`MISSING <scope>` が出たら manifest を貼り直して App を再インストールする）。multi-workspace（後述）では `--workspace <alias>` で alias ごとに token を保存・検証する。

> **User Token は任意。** Bot Token だけで public / private / DM / group-DM の sync は揃う。`search:read`（User Token 専用）が要るのは `slack conversations --sort=last_self_post` の engagement axis のみ（後述）。要らなければ manifest の `oauth_config.scopes.user` ブロックごと削ってよい。

### token / config

- **token**: Bot Token（`channels:history` / `groups:history` の read scope）。env override `SUASOR_CONNECTOR_SLACK_TOKEN`、keychain account `connector:slack:token`
- **token 未設定は channels の有無に関わらず error**: どの workspace にも token が解決できない場合、`slack sync` は `no token configured for any workspace` の error で **exit 1** する（[#385](https://github.com/ozzy-labs/suasor/issues/385)。channels 未設定の no-op 警告に credential 欠落が隠れない）。token がある workspace が 1 つでもあれば従来どおり（token 無し alias は warning + skip、[ADR-0014](../adr/0014-slack-multi-workspace.md)）
- **config（単一 workspace / 後方互換）**:

```toml
[connectors.slack]
team = "T0123ABCD"            # id prefix（rename しても安定）
channels = ["C0123ABCD"]      # 取り込み対象 channel **id**（名前不可・空なら何もしない）。id は `suasor slack conversations` で取得
since = "30d"                 # cold-start 下限（任意、ADR-0016）。相対 30d / 4w / 12h または ISO 日付 2026-01-01。不正値はロード時に ConfigError で fail-fast（#157）
self_user_id = "U0SELF"       # 自分の Slack user id（任意、ADR-0012）。slack.demand.list の @mention 検出用
discover_new = true           # sync 中に「未設定の新規参加会話」を検出して warn（任意・既定 true、ADR-0039）。false で無効化。取り込みはしない
[connectors.slack.channel_since]
C0123ABCD = "90d"             # per-channel の since 上書き（任意、#57）。未指定 channel は since にフォールバック。許容フォーマットは since と同じ（不正値はロード時 ConfigError、#157）
```

- **config（マルチ workspace、[ADR-0014](../adr/0014-slack-multi-workspace.md)）**: `[connectors.slack.workspaces.<alias>]` を並べると 1 install で N workspace を取り込む。flat な `[connectors.slack]`（上）は `default` alias として後方互換に読む。

```toml
[connectors.slack.workspaces.acme]
team = "T0ACME"
channels = ["C0ACME1", "C0ACME2"]
[connectors.slack.workspaces.beta]
team = "T0BETA"
channels = ["C0BETA1"]
```

  token は alias ごとに `connector:slack:<alias>:token`（env override `SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN`）。`suasor slack auth set/test` / `slack conversations` は `--workspace <alias>` で対象 token を切り替える。`slack sync` は全 alias を **per-workspace エラー隔離**で処理する：token 未設定の alias は warning を出して skip し、fetch 途中で失敗した alias も warning を出して**他 alias の取り込み・cursor 前進は止めない**（失敗 alias の prior cursor は保持＝reset しない）。全 alias が失敗した場合は error で終了する（#56）。

- **`--workspace` 省略時の解決**（[#371](https://github.com/ozzy-labs/suasor/issues/371) テーマ1）: operational verb（`slack auth set/test` / `conversations` / `cursor reset/backfill`）は `--workspace` 省略時、config 形状で対象 workspace を決める。**flat `[connectors.slack]`**（`workspaces` 無し）は従来どおり `default`（secret 名 `token`）。**単一の named workspace** だけなら**その alias を自動採用**する（かつては flat の `token` を無言で見に行き「該当 workspace をリセットしたつもり」の no-op になっていた）。**2 つ以上の workspace** があり `default` alias も無い場合は、**利用可能な alias を列挙してエラー**にする（`error: multiple Slack workspaces configured (acme, beta); pass --workspace <alias> to choose one.`）。`default` alias が定義済みなら省略時にそれへフォールバックする。
- **token の env override 名**（[#371](https://github.com/ozzy-labs/suasor/issues/371) テーマ4）: token 未解決時のエラーは、その workspace の env override 名を名指しする（headless / WSL 用）。名前は `SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN` で、alias の英数字以外（`-` など）は `_` に正規化される（例: `beta-eu` → `SUASOR_CONNECTOR_SLACK_BETA_EU_TOKEN`）。flat/default は `SUASOR_CONNECTOR_SLACK_TOKEN`。`slack conversations` が出す paste-ready な config block も各 workspace セクションにこの env override 名 + `slack auth set --workspace <alias>` の導線をコメントで併記する。マルチ workspace 検出時は「これは `[connectors.slack.workspaces.<alias>]`（multi）形式で、**各 workspace に個別 token が要る**」旨の note も出す（flat block を貼った後に `workspace 'X' skipped: no token` で気づく事故を防ぐ）。
- **`self_user_id` の発見**（[#371](https://github.com/ozzy-labs/suasor/issues/371) テーマ2）: `slack auth test` は解決した `user_id`（`U…`）を出力し、`self_user_id = "U…"` として当該 workspace セクション（flat は `[connectors.slack]`、named は `[connectors.slack.workspaces.<alias>]`）に貼るよう案内する。`self_user_id` 未設定だと `slack.demand.list` は **@mention を検出できず DM-only に無言 degrade** する（[ADR-0012](../adr/0012-slack-demand-digest.md)）ので、multi workspace では各 alias 分を設定する。
- **出力の workspace 識別**（[#371](https://github.com/ozzy-labs/suasor/issues/371) テーマ3）: `slack status` は各 alias に team id + 解決済み workspace 名（`slack_teams` projection 由来、[ADR-0037](../adr/0037-slack-name-enrichment.md)）を併記する（例: `[acme]  team T0ACME (Acme Inc)`）。`cursor reset/backfill` も対象 workspace の team を stderr に示す。名前未解決なら team id にフォールバックする。

  **ws 別サマリ + exit code**（[ADR-0014](../adr/0014-slack-multi-workspace.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)）: sync 末尾に **workspace 別サマリ行**を 1 本出す（例: `slack: workspaces: acme=ok, beta=failed (cursor preserved), gamma=skipped (no token)`）。さらに**一部の ws だけが失敗した部分失敗**でも **exit 1** で終了する（取り込めた ws のレコードはそのまま保持される）。これにより cron / CI が exit code を gate に部分失敗を検知できる（従来は「全 ws 失敗時のみ exit 1」で部分失敗が exit 0 に隠れていた）。`suasor sync`（全 connector 一括, [ADR-0027](../adr/0027-bulk-sync-orchestration.md)）経由でも、Slack の部分失敗は connector 失敗として集計され全体が exit 1 になる。失敗 ws の cursor 非リセット（上記）は維持。

  **共有チャンネルの重複排除**（[ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) / [#363](https://github.com/ozzy-labs/suasor/issues/363)）: Enterprise Grid では 1 つのチャンネルが**複数 workspace に共有**される（部門横断・社外 BP 連携など）。共有チャンネルは Grid 全体でグローバル一意な 1 つの channel ID を持つため、同一 channel ID を複数 alias の `channels` に列挙しても、sync は **owner の 1 workspace でのみ 1 回だけ取り込む**（残りの alias では skip）。owner は当該チャンネルを列挙する **alias 名の辞書順で最小**のもの（TOML パーサ順に依存しない決定的ルール。再 sync をまたいで安定）。共有を検出すると 1 本の warn に集約して owner と skip 対象を示す（例: `channel C123 shared across [bp, employees] → ingesting under 'bp'`）。cursor は owner のみが持つ。externalId 形式は不変なので**単一 workspace 設定・非共有チャンネルは挙動不変**。前提「channel ID がグローバル一意」は同一 Grid 内で成立し、Slack Connect（外部 org 共有）は対象外（[ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) §6）。

  **既存の重複 source を cleanup する**（[ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) Layer 1 の導入**前**に二重取り込み済みの環境向け）: 上記 dedup は**今後の sync**で共有チャンネルを owner のみ取り込むが、Layer 1 導入前に既に二重取り込みされた環境には、非 owner alias 側の**過去の重複 message source が残る**。非 owner 側の重複は externalId prefix `slack:<非owner-team>:<共有channel>:*` で識別できる（owner の source はそのまま残す）。cleanup 手順:

  1. **非 owner alias の当該 channel を config から外す** — `[connectors.slack.workspaces.<非owner-alias>]` の `channels` から共有 channel id を削除する（今後は owner のみが取り込む）。owner は当該 channel を列挙する alias 群のうち **alias 名の辞書順で最小**のもの。`suasor doctor` の共有チャンネル warn（後述）が owner と skip 対象を名指しするので、どの alias から外すかが sync を回さず一目で分かる。
  2. **projection を再構築する** — `suasor projections rebuild` で event replay により projection を再構築する。これで `slack_channels.team_id` の last-write-wins flip（[ADR-0037](../adr/0037-slack-name-enrichment.md)）が owner 基準へ収束する（[ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) §4）。
  3. **残存する非 owner の重複 source を purge する** — projection 再構築後も event log には過去に取り込んだ非 owner の重複 message source が残る（rebuild は event を replay するだけで過去 source を消さない）。`suasor source list --type slack_message` で `slack:<非owner-team>:<共有channel>:*` prefix の externalId を確認し、`suasor source forget <externalId>`（[ADR-0026](../adr/0026-source-forgetting.md)・破壊的・`--yes` で適用）で本文を redaction + projection/FTS/vector から削除する。

  cleanup 後は共有チャンネルが owner の 1 系統に収束し、`slack.demand.list` / `search` / `brief` の重複ヒットが解消する。cleanup 対象の特定には `suasor doctor` の共有チャンネル warn（[ADR-0038](../adr/0038-multi-workspace-shared-channel-dedup.md) Layer 3）を使う: sync を回さずとも同一 channel id が複数 alias に列挙されていることを検出し、owner（辞書順最小 alias）と skip 対象を示す。

  **未参加 channel の warn**（[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) / [#165](https://github.com/ozzy-labs/suasor/issues/165)）: `auth test` の `READY` は **scope だけ**の判定で、channel への到達可否（membership）は別レイヤ。bot が join していない（`/invite` されていない）channel は sync 時に Slack が `not_in_channel` を返し、その channel は**空のまま・エラーも出ない**＝silent になりがち。そこで sync は `not_in_channel`（および `channel_not_found` / `is_archived` の channel 単位到達不能エラー）を **per-workspace で 1 本の warn に集約**し、どの channel が未到達かを明示する（`workspace '<alias>': N channel(s) unreachable — C123 (not_in_channel), …`）。これは **channel 単位**の skip であり、同 workspace の他の到達可能 channel の取り込みは止めず、未到達 channel の prior cursor も保持する（reset しない）。`ratelimited` 等の workspace 全体エラーは従来どおり per-workspace 隔離（上記）で扱う。

- **identity**: `slack:<team>:<channel>:<ts>`（team prefix で workspace 横断一意）/ **source_type**: `slack_message`
- **thread replies**（[ADR-0015](../adr/0015-slack-thread-replies.md)）: `conversations.history` の各メッセージで `reply_count > 0` の親について `conversations.replies` を辿り、返信も取り込む（返信を持たないメッセージは叩かない＝N+1 抑制）。返信も同じ identity / `threadTs` meta で、per-channel cursor は履歴と返信の最大 `ts` を共有する。注意: 親が cursor/floor より古いスレッドへの新規返信は対象外（thread 単位 cursor は持たない設計）
- **差分検知**: `conversations.history` の `oldest` cursor。cursor は **alias → channel** の最新 `ts` を持つ JSON map（`{ "<alias>": { "<channel>": "<ts>" } }`）で、各 channel は自分の high-water mark から resume する（[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) / [ADR-0014](../adr/0014-slack-multi-workspace.md)）。旧来の flat map（`{ "<channel>": "<ts>" }`）は `default` alias、単一 `ts` は upgrade 後初回の floor として後方互換解釈する
- **オンボーディング**（[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)）:

```bash
suasor slack auth set                  # token を keychain に保存（stdin / --token）
suasor slack auth test                 # 検証 + granted scopes + feature readiness
suasor slack conversations             # 可視会話を列挙し [connectors.slack] ブロックを出力
suasor slack conversations --new       # config 未設定の新規参加会話だけを差分表示（後述）
# → 出力ブロックを config.toml に貼り、enabled にして
suasor slack sync                      # （= <connector> sync）取り込み
```

  `auth test` は scope ごとに `public channel sync` / `private channel sync` / `DM sync` / `group-DM (mpim) sync` / `engagement axis` の readiness（`READY` / `READY (degraded: +users:read …)` / `MISSING <scope>` / `N/A (User Token only)`）を出す。READY は scope の保証のみで、未参加 channel は `not_in_channel` のまま（membership は別レイヤ）。未参加 channel は sync 時に集約 warn で明示される（上記「未参加 channel の warn」）。設定前に到達可否を見たい場合は `slack conversations` の参加印（後述）を使う

  `conversations` の表示は先頭に `Joined  ID / Name` ラベル行を付け、**1 列目が参加印・2 列目（id）こそ `channels` に貼る値**だと明示する（[#158](https://github.com/ozzy-labs/suasor/issues/158) / [#165](https://github.com/ozzy-labs/suasor/issues/165)）。**参加印** `✓` は token の principal がその会話の member（＝ sync で到達可能）であることを示し、印が無い channel は未参加＝ sync 時に `not_in_channel` で空になる（ADR-0011；Slack の `is_member` 由来、DM / group-DM は常に member。未参加 channel が 1 つでもあれば stderr に補足 note を出す。`--json` は各会話に `isMember` を含む）。**type 内で a-z ソート**され、**DM は相手の表示名を `users.info` で解決**して `dm:<name>` で出す（`users:read` 必要、未解決時は `dm:<userId>` にフォールバック）。出力する `[connectors.slack]` ブロックの `channels` も id（`#` コメントは表示名ラベルのみ）。DM の逐次 `users.info` 解決と `--sort=last_self_post` の `search.messages` ページングは長くなりがちなので **stderr に進捗（処理件数）を表示**する（`sync` と同じ `createProgress`・TTY 限定・`--no-progress` で無効化、#84）。

  > **channels は id（名前不可）。** `channels` には会話 **id**（`C…` public / `G…` private・group-DM / `D…` DM）を指定する。`#general` のような channel **名**を貼ると `conversations.history` が id を引けず**無音でゼロ件取り込み**になるため、`sync` 時に `C/D/G` で始まらない値は warning を出す（ハード強制はしない＝将来 id プレフィックスが増えてもロックしない、[ADR-0007](../adr/0007-connector-contract.md) / [#158](https://github.com/ozzy-labs/suasor/issues/158)）。id は `suasor slack conversations` で取得する。

#### 新規会話の見つけ方（`--new`・[ADR-0039](../adr/0039-conversation-discovery-drift.md)）

  `channels` は**明示列挙**（＝データ最小化・取り込み範囲の明示制御、[ADR-0003](../adr/0003-local-first-and-content-minimization.md) / [ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)）なので、初期設定後にチャンネルへ新規参加しても**自動では取り込まれない**。取りこぼすと「参加しているのに suasor に入ってこない」＝ demand / 検索 / brief の網羅性が落ちる。`suasor slack conversations --new` はこの **drift（token で見える会話と config の `channels` の差分）だけ**を表示する（全一覧を目視で漁らなくてよい）:

- **新規**（`isMember` だが config 未設定）を、そのまま貼れる `[connectors.slack]` fragment（`renderConfigBlock` 再利用）で出力する。未参加（`✓` なし）会話は取り込んでも空なので候補から除外する。
- **消失**（config にあるが token で到達不能 = 退出 / アーカイブ / 改名）は stderr に warn で surface する（**自動削除はしない**＝取り込み判断は運用者に残す）。
- 差分の既定 sweep は **public + private のみ**（DM / group-DM はノイズが多い）。`--types public,private,im,mpim` で広げられる。config 済みの DM id は未 sweep でも「消失」に誤判定しない。
- `--json` は**新 flag なので新形状** `{ new: [...], removed: [...] }` を返す。既存の全列挙 `slack conversations --json`（`{ teamId, conversations, … }`）は**不変**。
- `--workspace <alias>` で単一 workspace にスコープする（Enterprise Grid の自動列挙は `--new` では行わない）。
- **silent auto-follow は既定にしない**（[ADR-0039](../adr/0039-conversation-discovery-drift.md)）。追記導線 (`--apply`) は後続 PR（Layer 3）で判断。

##### sync 中の自動検出 + `doctor` drift チェック（[ADR-0039](../adr/0039-conversation-discovery-drift.md) Layer 2）

  「都度 `--new` を手で実行」を不要にするため、`slack sync` は各 workspace の token 解決後に軽く `users.conversations`（public + private のみ）を sweep し、config 外の **member 会話**があれば **1 行集約 warn**（`N new conversation(s) visible but not in config — run \`suasor slack conversations --new\` …`）を出す。**取り込みはせず cursor も不変**（明示列挙のプライバシー設計を維持）。

- **opt-out**: `[connectors.slack] discover_new = false`（既定 `true`）。マルチ workspace は `[connectors.slack.workspaces.<alias>] discover_new` で per-workspace 上書き可（per-workspace 値 > connector 値 > 既定 `true`）。
- **cadence（間引き）**: 毎 sync では叩かず **前回 sweep から 24h 経過した workspace のみ** sweep する。最終 sweep 時刻 + 新規件数は connector cursor 内の予約キーに軽量保持し（channel cursor とは別、`slack status` / `cursor reset` には出ない）、追加の projection / event は作らない。
- **単発トグル（[ADR-0039](../adr/0039-conversation-discovery-drift.md) §3）**: config を書き換えずその回だけ挙動を変える CLI flag（`connector-sync` 共通・Slack のみ honor）:
  - `suasor slack sync --discover` — 24h cadence（および `discover_new = false` opt-out）を無視して**即時 sweep**。新規チャンネル参加直後に drift をすぐ確認したいとき用。
  - `suasor slack sync --no-discover` — config が `discover_new = true` でも**その回の sweep を抑止**（cadence marker・cursor は不変）。
  - 両方を同時指定すると error（相反）。未指定は従来どおり config（`discover_new` + cadence）に従う。Slack 以外の connector では両 flag とも no-op（discovery 概念が無い）。
- **best-effort**: sweep が失敗しても sync 本体・cursor 前進は止めず warn のみ。rate-limit は共有 `slackFetch`（[ADR-0019](../adr/0019-slack-fetch-rate-limit-retry.md)）に乗る。
- **`suasor doctor`** はネットワークを叩かず、この sweep が保存した drift marker を読み取って「N 件の新規 Slack 会話が未追加」を **WARN** で surface する（exit code は変えない・診断はオフライン、[ADR-0039](../adr/0039-conversation-discovery-drift.md)）。`discover_new = false` の workspace は stale marker を表示しない。

- **demand signal**（[ADR-0012](../adr/0012-slack-demand-digest.md)）: 取り込み済み `slack_message` から @mention（`self_user_id` 設定時）/ DM を MCP `slack.demand.list` で「読むべきが未処理」signal として取得（query 導出・追加 fetch なし）。`next-actions` / `personal-brief` skill が priority 上位に組み込む。
- **engagement axis**（[ADR-0013](../adr/0013-slack-engagement-axis.md)）: `suasor slack conversations --sort=last_self_post` で「自分が最後に投稿した時刻」順に会話を並べる。`search.messages`（`from:me`）を使うため **User Token（`xoxp-`）専用**で、Bot Token では `N/A` に degrade（通常順で列挙）。値は Slack 全文 index の遅延により概算。表の `last_self_post` 列は人間可読時刻（`YYYY-MM-DD HH:MM (<相対時刻>)`）で出す（`--json` は raw ts 維持、#84）。
- **rate-limit retry**（[ADR-0019](../adr/0019-slack-fetch-rate-limit-retry.md)）: 運用/discovery/auth/search の fetch 経路（`users.conversations` / `users.info` / `auth.test` / `search.messages`）は 429 で即死せず、`Retry-After` を尊重（無ければ 1s/2s/4s backoff・既定 3 試行）して回復する（共有 `slackFetch`）。sync hot path（`conversations.history` / `replies`）は `@slack/web-api` の既定 retry に委譲（二重に持たない）。
- **date floor / recovery**（[ADR-0016](../adr/0016-slack-sync-date-floor.md)）: `since`（per-workspace 可）で cold-start の下限を設ける。下限は saved cursor が無い channel にのみ適用され、resume 済み channel は cursor を優先する。`since` / `channel_since` の値は **config ロード時に解析可否を検証**し、相対（`30d` / `4w` / `12h`）にも ISO 日付（`2026-01-01`）にも解せない値（例: `"3 weeks"`）は `ConfigError` で fail-fast する（無音で「floor 無し」に化けて全履歴 backfill が暴発するのを防ぐ、[ADR-0007](../adr/0007-connector-contract.md) / #157）。運用 verb:
  - `suasor slack status [--json]` — 保存中の cursor（workspace / channel ごとの resume ts）を表示。resume ts は人間可読時刻（`YYYY-MM-DD HH:MM (<相対時刻>)`）で出し、「どの channel をいつまで取り込んだか」が一目で分かる（`--json` は raw ts 維持、#84）
  - `suasor slack cursor reset --channel C1,C2 | --all [--workspace A] [--yes]` — cursor を消し、次回 sync で `since` floor から取り直す（`--yes` 無しは preview のみ）
  - `suasor slack cursor backfill --channel C1 --since 180d [--workspace A] [--yes]` — 指定 channel の cursor を `--since` floor（現在位置より過去）へ下げ、次回 sync で未取得 window を取り直す（floor より古い backfill 用、#57）
  - `since` は per-channel 上書きも可（`[connectors.slack.channel_since]`、#57）
  - `suasor slack resolve-names [--workspace A] [--force] [--json]` — 既に取り込み済みの `slack_message` source を走査し、名前が未解決のままの channel / user id を `conversations.info` / `users.info` で遡及解決して projection を enrich する（前方 sync は新規取り込み分しか名前を付けないため、[ADR-0037](../adr/0037-slack-name-enrichment.md) §11）。冪等（既に名前がある id は skip、`--force` で再解決）。scope 不足 / API エラーの id は skip して継続し、解決 / skip / degrade 件数を要約出力する。これにより `slack status` / `cursor` / `slack.demand.list` が id ではなく人間可読名で会話を提示できる

## Microsoft Graph（`ms-graph`）

Microsoft 365（Outlook mail / Calendar / OneDrive / Teams）を取り込む（`@microsoft/microsoft-graph-client` + `@azure/msal-node`、app-only client-credential フロー）。

- **token**: App registration の client secret。env override `SUASOR_CONNECTOR_MS_GRAPH_CLIENTSECRET`、keychain account `connector:ms-graph:clientSecret`
- **config**:

```toml
[connectors.ms-graph]
tenantId = "<directory-id>"
clientId = "<app-client-id>"
user = "user@contoso.com"               # 対象メールボックス / ドライブ
resources = ["mail", "calendar"]        # mail | calendar | files | teams
```

- **identity**: `msgraph:<resource>:<id>` / **source_type**: `ms365_mail` / `ms365_calendar` / `ms365_file` / `ms365_teams_message`
- **差分検知**: コレクションを `@odata.nextLink` でページングし、本文 fingerprint で未変更を skip。`files`（OneDrive）は DriveItem の content hash（`file.hashes.quickXorHash`、なければ sha256/sha1）を fingerprint に使い、リネーム無しの**内容変更も検知**して再抽出する（[ADR-0024](../adr/0024-document-extraction-sidecar.md) §6）。hash 不在時は body（ファイル名）の SHA-256 に fallback
- **本文抽出（OneDrive `files`）**（[ADR-0024](../adr/0024-document-extraction-sidecar.md) / [ADR-0034](../adr/0034-api-connector-extraction.md), #243）: `[extraction]` サイドカーを有効にすると、`files` リソースの Office/PDF（`.docx`/`.xlsx`/`.pptx`/`.pdf`）は Graph API（`GET /users/{user}/drive/items/{id}/content`）で本文を **read-only** で lazy fetch して抽出テキストに差し替える。`local` / `box` と同じ共通基盤（`src/connectors/sync.ts` の抽出段）を通る。mail / calendar / teams はテキスト本文をそのまま取り込むため抽出対象外。それ以外のファイルは **name-only**。詳細・degrade 挙動は [extraction ガイド](extraction.md) を参照
- **size guard**: DriveItem の `size` が `[extraction].maxBytes` 超過なら fetch せず name-only。fetch / 抽出失敗・unsupported も name-only に degrade（取り込み自体は成功）
- **onboarding**（Issue #85）: `suasor ms-graph auth set`（client secret を keychain に保存）/ `suasor ms-graph auth test`（client-credential token 交換で client secret + tenantId/clientId の疎通を検証し granted scope を出力）。`auth test` は config の `tenantId` / `clientId` を要求する。
- **feature readiness**（Issue #194）: `auth test` は config の `resources` ごとに `features:` 行を出す（Slack 同形式）。client-credential は `.default` を返し、実 application permission（Mail.Read / Calendars.Read / Files.Read.All / Channel・Chat.Read.All）は server 側で解決され token の `scope` に列挙されないため、各行は `N/A (scopes not enumerated)`（実権限は Azure app registration 側で確認する）。`resources` 未設定なら `ingestion: N/A (no resources configured)` の 1 行のみ:

  ```text
  ok: ms-graph credential for app <client-id> @ tenant <tenant-id>
  scopes: https://graph.microsoft.com/.default
  features:
    mail read (Mail.Read): N/A (scopes not enumerated)
    calendar read (Calendars.Read): N/A (scopes not enumerated)
  ```

## Google

Google Workspace（Drive / Gmail / Calendar）を取り込む（`googleapis`、OAuth2 refresh token）。

- **token**: OAuth refresh token（対象 API の read scope）。env override `SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN`、keychain account `connector:google:refreshToken`
- **config**:

```toml
[connectors.google]
clientId = "<oauth-client-id>"
calendarId = "primary"                   # calendar event の対象
resources = ["drive", "gmail", "calendar"]  # drive | gmail | calendar
```

- **identity**: `google:<resource>:<id>` / **source_type**: `google_drive` / `gmail_message` / `google_calendar`
- **差分検知**: `nextPageToken` でページングし、本文 fingerprint で未変更を skip。Drive ファイルは **content fingerprint**（binary は `md5Checksum`、Google ネイティブは md5 を持たないため単調増加の `version`）を使うため、リネーム無しの内容変更も検知して再取り込み・再抽出される。Gmail / Calendar は本文 SHA-256 fingerprint のまま
- **onboarding**（Issue #85）: `suasor google auth set`（refresh token を keychain に保存）/ `suasor google auth test`（refresh→access token 交換で疎通を検証し granted scope を出力）。`auth test` は config の `clientId` を要求し、installed/web client の場合は `connector:google:clientSecret` を keychain に置けば併せて使う（public client は不要）。
- **calendar discovery**（[ADR-0030](../adr/0030-connector-discovery-verbs.md)）: `calendarId` を Web UI から手写しすると typo で calendar の sync が **silent に 0 件**になりやすい。token から可視カレンダーを列挙して貼れる discovery verb を使う（github の `github repos` 相当）:

  ```bash
  suasor google calendars                  # 可視カレンダーを列挙し [connectors.google] ブロックを出力
  suasor google calendars --filter team    # id / summary の部分一致（case-insensitive）で絞る
  suasor google calendars --json           # items + configBlock を JSON 出力
  ```

  refresh token を access token に交換した上で `GET /calendar/v3/users/me/calendarList`（`nextPageToken` ページング）を `fetch` のみ（`googleapis` 非依存・import-clean、[ADR-0007](../adr/0007-connector-contract.md)）で列挙し、calendarId / summary / timeZone / primary を出す。config の `clientId` を要求し、installed/web client は keychain の `connector:google:clientSecret` を併せて使う（`auth test` と同型）。出力末尾の paste-ready な `[connectors.google]` ブロックは（github の `repos` 配列と違い）**単一の** `calendarId` を primary（または先頭）カレンダーに設定し、他カレンダーは `# calendarId = "..."` のコメント行で並べるので、貼り替えるだけで対象を切り替えられる。refresh token / client secret / access token は error に出さない。
- **feature readiness**（Issue #194）: `auth test` は config の `resources` ごとに `features:` 行を出す（Slack 同形式）。Google の token response は granted scope URL を列挙するため、各 resource の scope（`drive` / `gmail`（または `mail.google.com`）/ `calendar`）が granted scope に含まれれば `READY`、無ければ `MISSING <scope>`。`resources` 未設定なら `ingestion: N/A (no resources configured)` の 1 行のみ:

  ```text
  ok: google credential for client <client-id>
  scopes: https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/gmail.readonly
  features:
    Drive read: READY
    Gmail read: READY
    Calendar read: MISSING calendar
  ```

- **本文抽出**（[ADR-0024](../adr/0024-document-extraction-sidecar.md) / [ADR-0034](../adr/0034-api-connector-extraction.md), #242）: `[extraction]` サイドカーを有効にすると、Drive 上の Office/PDF（`.docx`/`.xlsx`/`.pptx`/`.pdf`）は Drive media エンドポイントで本文を **read-only** lazy fetch（`downloadFile`）、Google ネイティブ（Docs/Sheets/Slides）は Drive **export** エンドポイント（`exportFile`）で Office 形式（docx/xlsx/pptx）へ写像してから抽出テキストに差し替える。`local` / `box` と同じ共通基盤（`src/connectors/sync.ts` の抽出段）を通る。Gmail / Calendar や export 不能なネイティブ（Forms 等）は **name-only**。size guard（binary の `size` が `maxBytes` 超過なら fetch せず name-only）、fetch / export / 抽出失敗・unsupported の name-only degrade（取り込み自体は成功）。詳細は [extraction ガイド](extraction.md) を参照

## Box

folder 配下のファイルを取り込む（`box-typescript-sdk-gen`）。

- **token**: Developer / OAuth access token（対象 folder の read scope）。env override `SUASOR_CONNECTOR_BOX_TOKEN`、keychain account `connector:box:token`
  - **token 期限の注意**: Box の **developer token は 1 時間で失効する**（手元の検証・小規模 sync 向け）。大規模 sync や定期実行では失効のたびに `auth set` で token を取り直すか、失効しない **OAuth2 / JWT（server auth）token** を使うことを推奨する。
- **config**:

```toml
[connectors.box]
folders = ["0"]                          # 取り込み対象 folder id（root は "0"）
```

- **identity**: `box:file:<id>` / **source_type**: `box_file`
- **差分検知**: Box が返す `sha1`（content hash）を fingerprint に使い未変更を skip。content fingerprint なので**リネーム無しの内容変更も検知**して再取り込み・再抽出される。`sha1` 不在時は body（= ファイル名）の SHA-256 に fallback
- **onboarding**（Issue #85）: `suasor box auth set`（access token を keychain に保存）/ `suasor box auth test`（`GET /2.0/users/me` で token の有効性を検証し account login / name を出力）。
- **discovery**（[ADR-0030](../adr/0030-connector-discovery-verbs.md), #192）: `suasor box folders [--root <id>] [--filter S] [--json]`。`GET /2.0/folders/<id>/items`（folder entry のみ・marker ページング）を `fetch` のみ（SDK 非依存・import-clean）で列挙し、id / name の**ツリー**（`--root` 既定は Box root `"0"`、root 直下の 1 階層）を描画した上で paste-ready な `[connectors.box]` ブロック（`folders = [...]`、各行 `# <name>` ラベル）を出力する。`--root` で起点 folder を指定、`--filter` は name / id の部分一致、`--json` は `{items, configBlock}` を出力（token は出さない）。folder id 手写し typo による silent 0 件（[ADR-0007](../adr/0007-connector-contract.md)）を回避する。
- **feature readiness**（Issue #194）: Box の `users/me` は scope リストを持たない（live identity がそのまま判定）ため、`features:` は `Box folder read: READY` の 1 行（scope ゲートなし。folder への到達可否は別レイヤ）。
- **本文抽出**（[ADR-0024](../adr/0024-document-extraction-sidecar.md) / [ADR-0034](../adr/0034-api-connector-extraction.md), #241）: `[extraction]` サイドカーを有効にすると、Office/PDF（`.docx`/`.xlsx`/`.pptx`/`.pdf`）は Box API で本文を **read-only** で lazy fetch（`downloadFile`）して抽出テキストに差し替える。`local` と同じ共通基盤（`src/connectors/sync.ts` の抽出段）を通る。それ以外のファイルは **name-only**（ファイル名のみで名前検索可能）。詳細・degrade 挙動は [extraction ガイド](extraction.md) を参照
- **size guard**: Box が返す `size` が `[extraction].maxBytes` 超過なら fetch せず name-only。fetch / 抽出失敗・unsupported も name-only に degrade（取り込み自体は成功）

## Notion

ナレッジベース（standalone ページ・データベースの行）を取り込む。Notion REST API は plain JSON のため SDK を持たず `fetch` のみ（import-clean）で実装する。

- **token**: Notion internal integration token。env override `SUASOR_CONNECTOR_NOTION_TOKEN`、keychain account `connector:notion:token`
  - **共有が前提**: Notion は token scope ではなく、**integration を共有したページ / データベースだけ**が読める。取り込みたいページ・DB を Notion UI で integration に "Connect" / "Share" しておく必要がある（共有していない resource は discovery にも sync にも現れない）。
- **config**:

```toml
[connectors.notion]
databases = ["<database-id>"]            # 取り込み対象 DB の id（行ごとに 1 source）
page_depth = 10                          # block 再帰の深さ上限（既定 10）
pages = true                             # search で見える standalone ページも取り込む（既定 true）
```

- **identity**: `notion:page:<id>`（standalone ページ）/ `notion:db:<db-id>:item:<row-id>`（DB の行）。DB 行は db スコープの identity なので、同じ row id が 2 つの DB 配下にあっても衝突しない / **source_type**: `notion_page` / `notion_database_item`
- **本文**: ページ / 行のタイトル + block の再帰プレーンテキスト（`GET /v1/blocks/{id}/children` を `start_cursor` でページング）。`page_depth` で深さを制限し、synced block の循環参照は visited-id ガードで回避する
- **差分検知**: Notion に delta API は無いため、`last_edited_time` を **content fingerprint** として使う。`last_edited_time` が進めば本文未変更でも再取り込みし、変わらなければ no-op（cursor は `null`）
- **onboarding**（Issue #85）: `suasor notion auth set`（integration token を keychain に保存）/ `suasor notion auth test`（`GET /v1/users/me` で token の有効性を検証し bot 名 / workspace 名を出力）。
- **discovery**（[ADR-0030](../adr/0030-connector-discovery-verbs.md)）: `suasor notion databases [--filter S] [--json]`。`POST /v1/search`（`database` object のみ・`start_cursor` ページング）を `fetch` のみで列挙し、paste-ready な `[connectors.notion]` ブロック（`databases = [...]`、各行 `# <title>` ラベル）を出力する。`--filter` は title / id の部分一致、`--json` は `{items, configBlock}` を出力（token は出さない）。database id 手写し typo による silent 0 件（[ADR-0007](../adr/0007-connector-contract.md)）を回避する。
- **feature readiness**（Issue #194）: Notion の `users/me` は scope リストを持たない（capability は token scope ではなく **共有されたページ / DB** で決まる）ため、`features:` は `Notion page / database read: READY` の 1 行。
- **backoff**（[#269](https://github.com/ozzy-labs/suasor/issues/269)）: 全 fetch 経路（sync / auth / discovery）は共有 `withRetry` を通り、429 / 5xx は `Retry-After` を尊重して指数バックオフ + jitter で再試行する。

## Jira

issue / comment を取り込み、project / ticket の demand signal（GitHub issues とは別軸の agile context）を search / research / next-actions に供給する。Jira REST API は plain JSON のため SDK を持たず `fetch` のみ（import-clean）で実装する。

- **token**: Cloud は API token、self-hosted は PAT。env override `SUASOR_CONNECTOR_JIRA_TOKEN`、keychain account `connector:jira:token`
  - **email は config**: Cloud の HTTP Basic 認証は `email:apiToken` を使うため、`email` は **非機密の config 値**として持つ（keyring に入れるのは API token のみ）。self-hosted の `auth = "bearer"`（PAT）では `email` は不要。
- **config**:

```toml
[connectors.jira]
host = "example.atlassian.net"           # Jira サイトのホスト（scheme なし）
email = "you@example.com"                # Cloud (basic) 認証用。self-hosted PAT では省略
projects = ["PROJ"]                       # 取り込み対象 project key（issue + comment）
# jql = "assignee = currentUser()"       # projects の代わりに明示 JQL で 1 sweep（任意）
# auth = "basic"                          # basic（Cloud, 既定）| bearer（self-hosted PAT）
```

- **identity**: `jira:<host>:<project>:<issue-key>`（issue）/ `jira:<host>:<project>:<issue-key>:comment:<id>`（comment）。host + project スコープの identity なので、同じ issue key が別 host にあっても衝突しない / **source_type**: `jira_issue` / `jira_comment`
- **本文**: issue は `summary` + `description`（ADF / HTML → text 正規化は最小限）。comment は本文テキスト。`description` カスタムフィールドが欠如していても summary 単独に degrade して throw しない
- **差分検知**（FR-ING-3）: JQL `project = <key> AND updated >= "<ts>" ORDER BY updated ASC` で、各 project の最新 `updated` を **per-project cursor**（`{ "<project>": "<iso-ts>" }` の JSON）として保存し、次回はその high-water mark から再開する（Slack の per-channel パターン）。`jql` モードでは `__jql__` キー 1 本で同様に再開する。ページングは `startAt` / `maxResults`
- **per-project エラー分離**（[#193](https://github.com/ozzy-labs/suasor/issues/193)）: 1 project の失敗（404 / 403 等）は warn に集約して skip し、他 project の取り込みは継続する。失敗 project の cursor は保持（リセットしない）。全 project 失敗時のみ throw。partial failure は `partialFailure` + summary line で非ゼロ終了（[ADR-0027](../adr/0027-bulk-sync-orchestration.md)）
- **onboarding**（Issue #85）: `suasor jira auth set`（API token / PAT を keychain に保存）/ `suasor jira auth test`（`GET /rest/api/3/myself` で資格情報の有効性を検証し account 名 / email を出力）。
- **discovery**（[ADR-0030](../adr/0030-connector-discovery-verbs.md)）: `suasor jira projects [--filter S] [--json]`。`GET /rest/api/3/project/search`（`startAt` ページング）を `fetch` のみで列挙し、paste-ready な `[connectors.jira]` ブロック（`host` / `email` プレースホルダ + `projects = [...]`、各行 `# <name>` ラベル）を出力する。`--filter` は key / name の部分一致、`--json` は `{items, configBlock}` を出力（token は出さない）。project key 手写し typo による silent 0 件（[ADR-0007](../adr/0007-connector-contract.md)）を回避する。
- **feature readiness**（Issue #194）: Jira の `/myself` は scope リストを持たない（capability は token scope ではなく **認証アカウントの project 権限**で決まる）ため、`features:` は `Jira issue / comment read: READY` の 1 行。
- **backoff**（[#269](https://github.com/ozzy-labs/suasor/issues/269)）: 全 fetch 経路（sync / auth / discovery）は共有 `withRetry` を通り、429 / 5xx は `Retry-After` を尊重して指数バックオフ + jitter で再試行する。

## Web（`web`）

設定した URL（operator / carrier の登録ページ等）を headless browser で snapshot し、差分を検知する（`playwright-core`）。

- **token**: 不要（公開ページのみ。認証経路は持たない）
- **config**:

```toml
[connectors.web]
urls = ["https://operator.example.com/signup"]
browser = "chromium"                     # chromium | firefox | webkit
```

- **identity**: `web:<sha1(url)>`（URL ごとに安定）/ **source_type**: `web_page`
- **差分検知**: snapshot の抽出テキスト fingerprint。ページ内容が変わると更新として検知される（fingerprint 差分）
- **注**: `playwright-core` はブラウザバイナリを同梱しない。実行ホストで `npx playwright install` 等によりエンジンを用意する

## Local（`local`）

設定したローカルディレクトリ群を再帰走査し、ファイルを取り込む（[ADR-0023](../adr/0023-local-filesystem-connectors.md)）。OS 同期済みの Box Drive / OneDrive / Dropbox マウントや任意のフォルダを**パス設定だけで**カバーする汎用 connector で、vendor ごとに connector を増やさない。`web`（Playwright snapshot を包む）と同じ「ローカル発生源」パターン。

- **token**: 不要（ローカル FS のみ。認証経路は持たない）
- **config**:

```toml
[connectors.local]
roots = ["/Users/me/Library/CloudStorage/Box-Box", "/Users/me/OneDrive"]  # 走査対象ディレクトリ
# textExtensions = [".md", ".txt", ".json", ...]  # 本文を読む拡張子（既定: テキスト系一式）
# maxBytes = 1000000                               # 本文を読む最大バイト数（超過は name-only）
```

- **identity**: `local:<sha1(絶対パス)>`（パスごとに安定）/ **source_type**: `local_file`
- **roots はロード時に存在検証される**（[#188](https://github.com/ozzy-labs/suasor/issues/188), ADR-0007 「黙って誤らない」）: `roots` の各パスは **config ロード時**（`loadConfig` の per-connector slice 検証, [#162](https://github.com/ozzy-labs/suasor/issues/162)）に「存在し、読み取り可能なディレクトリであること」を検証する。typo（例 `/Users/me/OnDrive`）や存在しないパスは sync 時に warn+skip される前に `ConfigError` で fail-fast し、該当する `roots.<index>` を指す。symlink は（走査時に辿らない既存方針はそのままに）ロード時はリンク先がディレクトリかで判定する。空 `roots` は検証対象なし（そのまま通る）
- **本文**: `textExtensions` に一致しサイズが `maxBytes` 以内のファイルは本文（= ファイル名 + 内容）を取り込み、それ以外は **name-only**（ファイル名のみ）で取り込む（box と同様、名前で検索可能にする）
- **差分検知**（FR-ING-3）: `mtime:size:contentHash` の fingerprint。内容編集・メタデータ変更で更新として検知され、無変更ファイルは再 sync で skip される（delta API は無いため fingerprint ベース）
- **走査**: symlink は辿らない（read-only・循環回避）。読めないディレクトリ / ファイルは warning を出して skip し、pass 全体は止めない
- **注（API connector との住み分け、ADR-0023 §3）**: 同一ファイルを `box`（API）と `local`（FS）の両方で取り込むと二重化する。identity は実体（パス / `box:file:<id>`）基準で別 source になるため自動統合はされない。設定で「どの connector に任せる範囲か」を住み分ける運用とする

## 新しい connector の追加

1. `src/connectors/<name>.ts` に `Connector` 実装と factory を書く（SDK は `sync` 内で lazy import）
2. `src/connectors/registry.ts` に `<name>: () => import("./<name>.ts")` を 1 行追加する
3. `src/connectors/registry.ts` の `SECRET_NAMES` に connector が `ctx.secret(...)` で読む secret 名を登録する（auth 不要なら `[]`）。`suasor connectors list` の token 設定有無 introspection がこれを参照する
4. `[connectors.<name>]` の config slice を connector 側で Zod 検証する

CLI `suasor <name> sync` と MCP `connector.sync` は registry から自動的に利用可能になり、`suasor connectors list` にも自動で並ぶ。
