# Connectors

Connector はソースから **read 専用**で取り込む共通実装（[ADR-0007](../adr/0007-connector-contract.md) / [connector-contract](../design/connector-contract.md)）。取り込みは event として append され、本文はローカル projection に保持され、FTS 検索の対象になる（[ADR-0002](../adr/0002-event-sourced-architecture.md) / [ADR-0003](../adr/0003-local-first-and-content-minimization.md)）。

取り込みの起動経路は 2 つ。どちらも同一の sync service を呼ぶ:

- CLI: `suasor <connector> sync`
- MCP write tool: `connector.sync`（HITL。人の承認なしに実行しない。[mcp-surface](../design/mcp-surface.md)）

## 空構成（no-op config）は sync 前に warn される

connector が **有効**（`[connectors.X]` があり `enabled = false` でない）でも、取り込み対象が空（github が `repos` 未設定かつ `notifications = "off"`、box が `folders` 未設定、local が `roots` 未設定、web が `urls` 未設定、google / ms-graph が `resources` 空、slack がどの workspace も `channels` 未設定）だと sync は黙って 0 件で終わり、DB を覗くまで気づけない（[#187](https://github.com/ozzy-labs/suasor/issues/187)）。これを防ぐため、sync は実行前に空構成を検出して stderr に warning を出す（例: `warning: github: repos 未設定かつ notifications=off — 取り込み対象なし（config の repos を設定するか notifications を all/repos に）`）。

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

discovery verb を持つ connector（**github** = `repos` / **google** = `calendars` / **box** = `folders`）を onboard すると、ウィザードは `auth test` 後にその discovery probe を実行し、token から見える id を列挙して `[connectors.X]` ブロック（`repos = [...]` 等の id 配列入り）を生成し、そのまま非破壊追記する。`config.toml` に `enabled = true` だけでなく**取り込み対象 id まで**が入るため、id を手探りせず（typo による silent 0 件を回避して）setup が完結する。

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

## per-resource エラー分離（github / google / box / ms-graph）

複数リソース（github=repo / google=resource family / box=folder / ms-graph=resource family）を 1 pass で走査する connector は、**1 リソースの失敗が他リソースの取り込みを巻き添えにしない**（[ADR-0014](../adr/0014-slack-multi-workspace.md) の per-workspace エラー分離を Slack 以外へ一般化、[#193](https://github.com/ozzy-labs/suasor/issues/193)）。従来は 1 repo の `403` が同 pass の他 repo の取り込みも止めていた。

- **失敗リソースは skip して continue**：fetch 途中で失敗したリソースは warning に集約し、残りのリソースの取り込みは止めない。
- **warn は 1 本に集約**：`github: 2 repo OK, 1 failed (cursor preserved) — owner/x (403)` の形式で、どのリソースがなぜ失敗したかを明示する（kind は connector ごとに `repo` / `resource` / `folder`）。
- **cursor 非リセット**：失敗リソースの prior cursor は保持する（reset しない）。github は **共有 `since` cursor を失敗 repo の最新 `updated_at` まで前進させない**ため、失敗 repo の gap が次回 silent に skip されない（成功 repo のみが共有 floor を前進させる）。google / box / ms-graph は fingerprint ベース（cursor `null`）なので前進そのものが無く、次回再走査で復旧する。
- **全リソース失敗時のみ throw**：すべてのリソースが失敗した pass は「無音の空成功」ではなく **error** として終了する（最後のエラーを再 throw）。
- **部分失敗の exit code + サマリ**：一部だけ失敗した部分失敗は `partialFailure` を立て、sync 末尾に **リソース別サマリ行**（例: `repos: owner/a=ok, owner/b=failed (cursor preserved)`）を 1 本出し、cron / CI が exit code を gate に検知できるよう **exit 1** で終了する（取り込めたリソースのレコードは保持される、[ADR-0027](../adr/0027-bulk-sync-orchestration.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)）。Slack の per-workspace 分離と同じセマンティクス。

token を持つ connector（github / ms-graph / google / box）は、汎用の `auth set` / `auth test` verb で keychain への保存と検証ができる（Issue #85）。`suasor <connector> auth set`（stdin / `--token` で primary secret を keychain に保存）/ `suasor <connector> auth test`（資格情報の有効性を read-only round-trip で検証し identity・granted scopes・readiness を出力）。各 connector が読む primary secret は github=`token` / ms-graph=`clientSecret` / google=`refreshToken` / box=`token`。Slack は scope readiness とマルチ workspace を持つ独自の `slack auth set/test`（後述）を維持する。

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
- **config（単一 workspace / 後方互換）**:

```toml
[connectors.slack]
team = "T0123ABCD"            # id prefix（rename しても安定）
channels = ["C0123ABCD"]      # 取り込み対象 channel **id**（名前不可・空なら何もしない）。id は `suasor slack conversations` で取得
since = "30d"                 # cold-start 下限（任意、ADR-0016）。相対 30d / 4w / 12h または ISO 日付 2026-01-01。不正値はロード時に ConfigError で fail-fast（#157）
self_user_id = "U0SELF"       # 自分の Slack user id（任意、ADR-0012）。slack.demand.list の @mention 検出用
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

  **ws 別サマリ + exit code**（[ADR-0014](../adr/0014-slack-multi-workspace.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)）: sync 末尾に **workspace 別サマリ行**を 1 本出す（例: `slack: workspaces: acme=ok, beta=failed (cursor preserved), gamma=skipped (no token)`）。さらに**一部の ws だけが失敗した部分失敗**でも **exit 1** で終了する（取り込めた ws のレコードはそのまま保持される）。これにより cron / CI が exit code を gate に部分失敗を検知できる（従来は「全 ws 失敗時のみ exit 1」で部分失敗が exit 0 に隠れていた）。`suasor sync`（全 connector 一括, [ADR-0027](../adr/0027-bulk-sync-orchestration.md)）経由でも、Slack の部分失敗は connector 失敗として集計され全体が exit 1 になる。失敗 ws の cursor 非リセット（上記）は維持。

  **未参加 channel の warn**（[ADR-0011](../adr/0011-slack-operational-verbs-and-readiness.md) / [#165](https://github.com/ozzy-labs/suasor/issues/165)）: `auth test` の `READY` は **scope だけ**の判定で、channel への到達可否（membership）は別レイヤ。bot が join していない（`/invite` されていない）channel は sync 時に Slack が `not_in_channel` を返し、その channel は**空のまま・エラーも出ない**＝silent になりがち。そこで sync は `not_in_channel`（および `channel_not_found` / `is_archived` の channel 単位到達不能エラー）を **per-workspace で 1 本の warn に集約**し、どの channel が未到達かを明示する（`workspace '<alias>': N channel(s) unreachable — C123 (not_in_channel), …`）。これは **channel 単位**の skip であり、同 workspace の他の到達可能 channel の取り込みは止めず、未到達 channel の prior cursor も保持する（reset しない）。`ratelimited` 等の workspace 全体エラーは従来どおり per-workspace 隔離（上記）で扱う。

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

  `auth test` は scope ごとに `public channel sync` / `private channel sync` / `DM sync` / `group-DM (mpim) sync` / `engagement axis` の readiness（`READY` / `READY (degraded: +users:read …)` / `MISSING <scope>` / `N/A (User Token only)`）を出す。READY は scope の保証のみで、未参加 channel は `not_in_channel` のまま（membership は別レイヤ）。未参加 channel は sync 時に集約 warn で明示される（上記「未参加 channel の warn」）。設定前に到達可否を見たい場合は `slack conversations` の参加印（後述）を使う

  `conversations` の表示は先頭に `Joined  ID / Name` ラベル行を付け、**1 列目が参加印・2 列目（id）こそ `channels` に貼る値**だと明示する（[#158](https://github.com/ozzy-labs/suasor/issues/158) / [#165](https://github.com/ozzy-labs/suasor/issues/165)）。**参加印** `✓` は token の principal がその会話の member（＝ sync で到達可能）であることを示し、印が無い channel は未参加＝ sync 時に `not_in_channel` で空になる（ADR-0011；Slack の `is_member` 由来、DM / group-DM は常に member。未参加 channel が 1 つでもあれば stderr に補足 note を出す。`--json` は各会話に `isMember` を含む）。**type 内で a-z ソート**され、**DM は相手の表示名を `users.info` で解決**して `dm:<name>` で出す（`users:read` 必要、未解決時は `dm:<userId>` にフォールバック）。出力する `[connectors.slack]` ブロックの `channels` も id（`#` コメントは表示名ラベルのみ）。DM の逐次 `users.info` 解決と `--sort=last_self_post` の `search.messages` ページングは長くなりがちなので **stderr に進捗（処理件数）を表示**する（`sync` と同じ `createProgress`・TTY 限定・`--no-progress` で無効化、#84）。

  > **channels は id（名前不可）。** `channels` には会話 **id**（`C…` public / `G…` private・group-DM / `D…` DM）を指定する。`#general` のような channel **名**を貼ると `conversations.history` が id を引けず**無音でゼロ件取り込み**になるため、`sync` 時に `C/D/G` で始まらない値は warning を出す（ハード強制はしない＝将来 id プレフィックスが増えてもロックしない、[ADR-0007](../adr/0007-connector-contract.md) / [#158](https://github.com/ozzy-labs/suasor/issues/158)）。id は `suasor slack conversations` で取得する。

- **demand signal**（[ADR-0012](../adr/0012-slack-demand-digest.md)）: 取り込み済み `slack_message` から @mention（`self_user_id` 設定時）/ DM を MCP `slack.demand.list` で「読むべきが未処理」signal として取得（query 導出・追加 fetch なし）。`next-actions` / `personal-brief` skill が priority 上位に組み込む。
- **engagement axis**（[ADR-0013](../adr/0013-slack-engagement-axis.md)）: `suasor slack conversations --sort=last_self_post` で「自分が最後に投稿した時刻」順に会話を並べる。`search.messages`（`from:me`）を使うため **User Token（`xoxp-`）専用**で、Bot Token では `N/A` に degrade（通常順で列挙）。値は Slack 全文 index の遅延により概算。表の `last_self_post` 列は人間可読時刻（`YYYY-MM-DD HH:MM (<相対時刻>)`）で出す（`--json` は raw ts 維持、#84）。
- **rate-limit retry**（[ADR-0019](../adr/0019-slack-fetch-rate-limit-retry.md)）: 運用/discovery/auth/search の fetch 経路（`users.conversations` / `users.info` / `auth.test` / `search.messages`）は 429 で即死せず、`Retry-After` を尊重（無ければ 1s/2s/4s backoff・既定 3 試行）して回復する（共有 `slackFetch`）。sync hot path（`conversations.history` / `replies`）は `@slack/web-api` の既定 retry に委譲（二重に持たない）。
- **date floor / recovery**（[ADR-0016](../adr/0016-slack-sync-date-floor.md)）: `since`（per-workspace 可）で cold-start の下限を設ける。下限は saved cursor が無い channel にのみ適用され、resume 済み channel は cursor を優先する。`since` / `channel_since` の値は **config ロード時に解析可否を検証**し、相対（`30d` / `4w` / `12h`）にも ISO 日付（`2026-01-01`）にも解せない値（例: `"3 weeks"`）は `ConfigError` で fail-fast する（無音で「floor 無し」に化けて全履歴 backfill が暴発するのを防ぐ、[ADR-0007](../adr/0007-connector-contract.md) / #157）。運用 verb:
  - `suasor slack status [--json]` — 保存中の cursor（workspace / channel ごとの resume ts）を表示。resume ts は人間可読時刻（`YYYY-MM-DD HH:MM (<相対時刻>)`）で出し、「どの channel をいつまで取り込んだか」が一目で分かる（`--json` は raw ts 維持、#84）
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
- **差分検知**: `nextPageToken` でページングし、本文 fingerprint で未変更を skip
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
