# Connectors

Connector はソースから **read 専用**で取り込む共通実装（[ADR-0007](../adr/0007-connector-contract.md) / [connector-contract](../design/connector-contract.md)）。取り込みは event として append され、本文はローカル projection に保持され、FTS 検索の対象になる（[ADR-0002](../adr/0002-event-sourced-architecture.md) / [ADR-0003](../adr/0003-local-first-and-content-minimization.md)）。

取り込みの起動経路は 2 つ。どちらも同一の sync service を呼ぶ:

- CLI: `suasor <connector> sync`
- MCP write tool: `connector.sync`（HITL。人の承認なしに実行しない。[mcp-surface](../design/mcp-surface.md)）

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

keychain への格納はプログラム経由（`storeSecret("github", "token", <value>)`、`src/connectors/secrets.ts`）。専用 CLI は後続 Issue。

### 2. 対象リポジトリの設定

`~/.config/suasor/config.toml`（`SUASOR_CONFIG_DIR` で上書き）に `[connectors.github]` を追加する:

```toml
[connectors.github]
repos = ["owner/repo", "owner/another-repo"]  # 取り込み対象
state = "all"                                  # open | closed | all（既定 all）
# baseUrl = "https://github.example.com/api/v3"  # GitHub Enterprise の場合
```

`repos` が空の場合は何も取り込まない（トークンも要求しない）。

### 3. 取り込みの実行

```bash
suasor github sync            # 差分取り込み（前回の cursor から resume）
suasor github sync --full     # cursor を無視して全件再スキャン
suasor github sync --json     # 件数 + cursor を JSON 出力
```

出力例:

```text
github sync: 12 observed, 3 updated, 5 unchanged.
```

- **identity**: source の `external_id` は `gh:<owner>/<repo>:issue:<number>` / `gh:<owner>/<repo>:pull_request:<number>`（ソース横断で一意）
- **source_type**: `github_issue` / `github_pull_request`
- **差分検知**（FR-ING-3）: issues の `since` cursor（delta API）で更新分のみ取得し、本文 fingerprint で未変更を skip。再実行は冪等（未変更ソースは更新イベントを生まない）

### 4. 検索

取り込んだ本文（タイトル + 本文）は即座に FTS 検索の対象になる:

```bash
suasor search rocket
```

MCP 経由では `search` read tool で同じ検索ができる（[retrieval](../design/retrieval.md)）。embedding backend を有効にすると、取り込み時に本文が埋め込まれ `recall.search` の意味検索（言語跨ぎ・語彙ミスマッチ向け）も使える（[embedding setup](embedding.md)）。

すべての connector で取り込み・検索・delta 検知・secret 経路（env override > keychain）の挙動は同一。以下は各 connector 固有の token / config slice のみ記す。token は **config.toml には書かない**（env override か keychain）。

## Slack

channel メッセージを取り込む（`@slack/web-api`）。

- **token**: Bot Token（`channels:history` / `groups:history` の read scope）。env override `SUASOR_CONNECTOR_SLACK_TOKEN`、keychain account `connector:slack:token`
- **config（単一 workspace / 後方互換）**:

```toml
[connectors.slack]
team = "T0123ABCD"            # id prefix（rename しても安定）
channels = ["C0123ABCD"]      # 取り込み対象 channel id（空なら何もしない）
since = "30d"                 # cold-start 下限（任意、ADR-0016）。30d / 4w / 12h / 2026-01-01
self_user_id = "U0SELF"       # 自分の Slack user id（任意、ADR-0012）。slack.demand.list の @mention 検出用
[connectors.slack.channel_since]
C0123ABCD = "90d"             # per-channel の since 上書き（任意、#57）。未指定 channel は since にフォールバック
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

  token は alias ごとに `connector:slack:<alias>:token`（env override `SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN`）。`suasor slack auth set/test` / `slack conversations` は `--workspace <alias>` で対象 token を切り替える。`slack sync` は全 alias を **per-workspace エラー隔離**で処理する：token 未設定の alias は warning を出して skip し、fetch 途中で失敗した alias も warning を出して**他 alias の取り込み・cursor 前進は止めない**（失敗 alias の prior cursor は保持＝reset しない）。全 alias が失敗した場合のみ error で終了する（#56）。

- **identity**: `slack:<team>:<channel>:<ts>`（team prefix で workspace 横断一意）/ **source_type**: `slack_message`
- **thread replies**（[ADR-0015](../adr/0015-slack-thread-replies.md)）: `conversations.history` の各メッセージで `reply_count > 0` の親について `conversations.replies` を辿り、返信も取り込む（返信を持たないメッセージは叩かない＝N+1 抑制）。返信も同じ identity / `threadTs` meta で、per-channel cursor は履歴と返信の最大 `ts` を共有する。注意: 親が cursor/floor より古いスレッドへの新規返信は対象外（thread 単位 cursor は持たない設計）
- **差分検知**: `conversations.history` の `oldest` cursor。cursor は **alias → channel** の最新 `ts` を持つ JSON map（`{ "<alias>": { "<channel>": "<ts>" } }`）で、各 channel は自分の high-water mark から resume する（[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) / [ADR-0014](../adr/0014-slack-multi-workspace.md)）。旧来の flat map（`{ "<channel>": "<ts>" }`）は `default` alias、単一 `ts` は upgrade 後初回の floor として後方互換解釈する
- **オンボーディング**（[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md)）:

```bash
suasor slack auth set                  # token を keychain に保存（stdin / --token）
suasor slack auth test                 # 検証 + granted scopes + feature readiness
suasor slack conversations             # 可視会話を列挙し [connectors.slack] ブロックを出力
# → 出力ブロックを config.toml に貼り、enabled にして
suasor slack sync                      # （= <connector> sync）取り込み
```

  `auth test` は scope ごとに `public channel sync` / `private channel sync` / `DM sync` / `group-DM (mpim) sync` / `engagement axis` の readiness（`READY` / `READY (degraded: +users:read …)` / `MISSING <scope>` / `N/A (User Token only)`）を出す。READY は scope の保証のみで、未参加 channel は `not_in_channel` のまま（membership は別レイヤ）

- **demand signal**（[ADR-0012](../adr/0012-slack-demand-digest.md)）: 取り込み済み `slack_message` から @mention（`self_user_id` 設定時）/ DM を MCP `slack.demand.list` で「読むべきが未処理」signal として取得（query 導出・追加 fetch なし）。`next-actions` / `personal-brief` skill が priority 上位に組み込む。
- **engagement axis**（[ADR-0013](../adr/0013-slack-engagement-axis.md)）: `suasor slack conversations --sort=last_self_post` で「自分が最後に投稿した時刻」順に会話を並べる。`search.messages`（`from:me`）を使うため **User Token（`xoxp-`）専用**で、Bot Token では `N/A` に degrade（通常順で列挙）。値は Slack 全文 index の遅延により概算。
- **date floor / recovery**（[ADR-0016](../adr/0016-slack-sync-date-floor.md)）: `since`（per-workspace 可）で cold-start の下限を設ける。下限は saved cursor が無い channel にのみ適用され、resume 済み channel は cursor を優先する。運用 verb:
  - `suasor slack status [--json]` — 保存中の cursor（workspace / channel ごとの resume ts）を表示
  - `suasor slack cursor reset --channel C1,C2 | --all [--workspace A] [--yes]` — cursor を消し、次回 sync で `since` floor から取り直す（`--yes` 無しは preview のみ）
  - `suasor slack cursor backfill --channel C1 --since 180d [--workspace A] [--yes]` — 指定 channel の cursor を `--since` floor（現在位置より過去）へ下げ、次回 sync で未取得 window を取り直す（floor より古い backfill 用、#57）
  - `since` は per-channel 上書きも可（`[connectors.slack.channel_since]`、#57）

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
- **差分検知**: コレクションを `@odata.nextLink` でページングし、本文 fingerprint で未変更を skip

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
- **差分検知**: `nextPageToken` でページングし、本文 fingerprint で未変更を skip

## Box

folder 配下のファイルを取り込む（`box-typescript-sdk-gen`）。

- **token**: Developer / OAuth access token（対象 folder の read scope）。env override `SUASOR_CONNECTOR_BOX_TOKEN`、keychain account `connector:box:token`
- **config**:

```toml
[connectors.box]
folders = ["0"]                          # 取り込み対象 folder id（root は "0"）
```

- **identity**: `box:file:<id>` / **source_type**: `box_file`
- **差分検知**: 本文 fingerprint（sync service の body SHA-256）で未変更を skip
- **注（filename-only ingest）**: ファイル本文はダウンロードせず、取り込む `body` は**ファイル名のみ**。Box 取り込みはファイルを名前で検索可能にするが、ファイル内容のインデックスは行わない（本文抽出は将来対応）。fingerprint は body（= ファイル名）から導出するため、内容だけ変わってもファイル名が同じなら冗長な `SourceBodyUpdated` は発生しない（rename はファイル名 = body が変わるので更新として検知される）

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

## 新しい connector の追加

1. `src/connectors/<name>.ts` に `Connector` 実装と factory を書く（SDK は `sync` 内で lazy import）
2. `src/connectors/registry.ts` に `<name>: () => import("./<name>.ts")` を 1 行追加する
3. `[connectors.<name>]` の config slice を connector 側で Zod 検証する

CLI `suasor <name> sync` と MCP `connector.sync` は registry から自動的に利用可能になる。
