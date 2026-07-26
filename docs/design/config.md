# Config

Zod スキーマで定義（`src/config/`）。優先順位 **init args > env > 設定ファイル > defaults**。最小実装は foundation Issue（#6）に置き、各 feature（#7–#12）が自身の section を拡張する。

## 場所

- 設定ディレクトリ: `~/.config/suasor/`（`SUASOR_CONFIG_DIR` で上書き）
- 設定ファイル: `config.toml`（`Bun.TOML.parse` で都度読み込み。編集は次回起動で反映）
- secrets: OS keychain（@napi-rs/keyring、service `suasor` / account `connector:<name>:<secret>`）。env override 経路あり（headless/Docker 用）。実装は `src/connectors/secrets.ts`（lazy import）

## セクション

### `[storage]`（確定）

```toml
[storage]
# DB ファイルパス。未指定（null）なら <configDir>/suasor.db を採用
dbPath = "/path/to/suasor.db"
```

- `dbPath` 既定は `null` → loader が `<configDir>/suasor.db` に解決（`SUASOR_CONFIG_DIR` に追従）
- **ストアのファイル権限**（[ADR-0048](../adr/0048-at-rest-protection.md) 決定 2）: DB・`-wal` / `-shm`・`config.toml` は `0600`、config ディレクトリは `0700` で作られる。`openDatabase` のたびに適用されるので、**本 ADR 以前に作られたストアも次のコマンド実行で自動的に是正される**。`suasor doctor` の `storage.permissions` が実際の on-disk mode を読み返して報告し、`storage.disk_encryption` が OS のフルディスク暗号化を best-effort で報告する（macOS / Windows は判定、**Linux は `unknown`** — 推測で `ok` と言わない）
- `[storage.retention].bodyMaxAgeDays` 既定は `null`（**retention は既定 OFF**）。設定すると `suasor store retention` が対象を落とす（[ADR-0047](../adr/0047-storage-lifecycle.md) 決定 2）。**本文は全文検索から恒久的に消える**（event log からも消えるので rebuild でも戻らない）ため、既定 ON にはしない。**残すもの**: source 行・メタデータ・provenance link・embedding — 「いつ・誰から・何に繋がっていたか」は本文より桁違いに小さく、想起の足がかりとして最も効く
- `sizeWarnBytes` 既定は `null`（警告なし）。設定すると `doctor` が現在サイズ・平均成長率・**上限到達までの日数**を出し、30 日以内なら warn する（[#498](https://github.com/ozzy-labs/suasor/issues/498) / [ADR-0047](../adr/0047-storage-lifecycle.md)）。retention は opt-in・既定 OFF なので、**判断のタイミングを逃さないための可視化**が先に立つ
- encryption 等の追加項目は将来 Issue で拡張

### `[embedding]`（確定）

```toml
[embedding]
backend = "disabled"   # disabled（既定）| ollama | openai | voyage（local=in-process は不採用）
baseUrl = "http://localhost:11434"  # ollama サイドカー。/api/embed は client が付与
model = "bge-m3"                     # 埋め込みモデル。ingest と query で同一（ベクトル空間整合）
dim = 1024                           # 埋め込み次元。model の出力次元と一致必須（bge-m3=1024）
maxBatch = 64                        # 1 リクエストあたり最大件数。超過は順序保持で分割（Issue #267）
maxInputChars = 8000                 # 1 text あたり最大文字数。超過は embed 前に明示 truncate（retrieval-m1・0 で無効）
requestTimeoutMs = 60000             # per-request timeout（ms）。timeout は abort して retry（0 で無効）
maxRetries = 3                       # 429/5xx の最大試行回数（初回含む）。1 で retry 無効
# allowRemote = false                # ollama サイドカーが非 loopback baseUrl のとき true 必須（Issue #436・egress opt-in）
```

- `backend` 既定 `disabled`（base install を軽く保つ）。意味検索（`search` の `mode=semantic` / `hybrid`）は無効時に空 + `embedding_disabled` シグナルで FTS に degrade（[retrieval](retrieval.md) / [ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
- **egress-free な `ollama`（ローカルサイドカー）が既定の推奨経路**。`openai` / `voyage` も実装済みだが、本文を外部 API に送る **egress を伴う**（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）opt-in 経路で、`ollama`（ローカル完結・egress なし）と非対称。両者は **API キー（OS キーチェーン / 環境変数、config に平文で書かない）でゲート**され、キー未設定なら embedder は `null` ＝ FTS に degrade し、黙って無効化されないよう **起動時（`suasor mcp serve`）と `suasor doctor` が「キー未設定」WARN を出す**（silent-error 撲滅・[Issue #235](https://github.com/ozzy-labs/suasor/issues/235) / [Issue #259](https://github.com/ozzy-labs/suasor/issues/259)）。API キー env は `SUASOR_EMBEDDING_<BACKEND>_API_KEY`、keyring account は `embedding:<backend>:apiKey`（service `suasor`）。詳細は [embedding guide](../guide/embedding.md)
- `baseUrl` / `model` は backend ごとに合わせる。ollama は `/api/embed`、openai/voyage は `/v1/embeddings` が client で付与される。既定 model は ollama `bge-m3`(1024-dim) / openai `text-embedding-3-small`(1536-dim) / voyage `voyage-3`(1024-dim)。`model` は **ingest（文書）と query（クエリ）で必ず同一**（混在すると recall が静かに劣化するため、単一値が両方を駆動）
- `dim` は埋め込みベクトルの次元で、`model` の出力次元と一致必須（`bge-m3`=1024、例: `nomic-embed-text`=768）。DB 作成時に vec0 テーブルのサイズを決めるため、既存ストアで変えるには新規 DB（または delete + rebuild + 再 sync）が必要。不一致だと全ベクトル挿入が失敗し recall が静かに空へ degrade するため、非 1024 次元 model を使うときは必ず設定する。不一致は **初回 embed で fail-fast**（actionable な `EmbeddingError`）し、`suasor doctor` も「model 出力次元 vs `dim`」を probe して不一致を ERROR で surface する（Issue #267）。さらに `suasor validate-config` は **既存 DB の vec0 次元 vs `dim`** を純 local read（egress なし・backend 不要）で突合し、不一致を ERROR finding として出す（backend 無効や API キー未設定でも検知できる経路。Issue #294）。`validate-config` は併せて「形式は valid だが runtime で効かない」設定（外部 embedding backend のキー未設定・廃止済み `[llm]` 節の残存）を **readiness advisory** として表示する（exit code には影響しない）
- `maxBatch` / `requestTimeoutMs` / `maxRetries` は外部 embedding egress の堅牢化（Issue #267）。`maxBatch` を超える入力は**順序を保って分割**し各 chunk の結果を結合する（大規模 sync で 413 / context 超過の全滅を防ぐ）。`requestTimeoutMs` は per-request timeout（超過は abort して transient 失敗として retry。`0` で無効）。`maxRetries` は 429/5xx に対する指数 backoff + jitter retry の最大試行回数（`Retry-After` を尊重・上限 60s、`1` で retry 無効）。**送信内容は変えず堅牢性のみ追加**（ADR-0003）。共有 backoff util は `src/util/retry.ts`（connector からも再利用）
- **`ollama` サイドカーの `baseUrl` は loopback allowlist（`localhost` / `127.0.0.0/8` / `::1`）でゲート**される（Issue #436・[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）。非 loopback（例: リモートの共有 ollama）は本文を egress するため、`allowRemote = true` を明示しない限り **load 時に `ConfigError` で fail-fast**（`suasor doctor` は config error として surface）。opt-in 時は起動 / doctor / validate-config が remote egress を **WARN で開示**する。`openai` / `voyage` は remote 前提の外部 API で、loopback ゲートの対象外（従来どおり API キーでゲート）
- `maxInputChars`（既定 8000・`0` で無効）は 1 text の最大文字数（retrieval-m1）。長文本文は embed 前に**決定的に truncate** し、model 依存の無音挙動（Ollama 先頭切詰め / OpenAI・Voyage の 400 全滅）を backend 非依存で観測可能にする。さらに embed は **per-text 失敗隔離**で 1 長文の失敗を穴に留め、兄弟ベクトルを巻き込まず drain も塞がない（全 text が単独でも落ちた systemic 障害のみ throw）。恒久解の chunked multi-vector は follow-up（[embedding guide](../guide/embedding.md#長文ドキュメントの扱いretrieval-m1)）
- 未知キーは保持（`passthrough`）し、backend 固有項目を後続が確定する
- env override 例: `SUASOR_EMBEDDING__BACKEND=ollama` / `SUASOR_EMBEDDING__MODEL=bge-large` / `SUASOR_EMBEDDING__BASEURL=http://sidecar:11434`（非 loopback host は `SUASOR_EMBEDDING__ALLOWREMOTE=true` を併記）

### `[extraction]`（確定・ADR-0024）

```toml
[extraction]
backend = "disabled"   # disabled（既定）| markitdown
# baseUrl = "http://localhost:8929"   # markitdown sidecar（/extract を付加）
# allowRemote = false                 # 非 loopback baseUrl のとき true 必須（Issue #436・egress opt-in）
# maxBytes = 5000000                  # 入力バイト数の上限。超過は fetch せず name-only に degrade
# maxTextChars = 5000000              # 抽出テキストの文字数上限。超過は打ち切り + 警告（state=truncated）
# version = "1"                       # extractor version。bump で既存 source を次 sync で再抽出
```

- Office/PDF（docx/xlsx/pptx/pdf）本文を text/Markdown 化する任意のサイドカー（[ADR-0024](../adr/0024-document-extraction-sidecar.md)）。既定 `disabled` で、無効時は従来どおり name-only（取り込みは成功）
- ML 委譲（[ADR-0006](../adr/0006-ml-delegation.md)）: 変換はサイドカー、本体は thin client のみ（in-process パーサ無し）。失敗は best-effort で warning + name-only fallback
- 初期スコープは **`local` connector 限定**（box/drive(API) は内容 fetch + 内容 fingerprint を要する後続 Issue で段階化）
- **`baseUrl` は loopback allowlist（`localhost` / `127.0.0.0/8` / `::1`）でゲート**（Issue #436・[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）。markitdown は文書バイト全体を送るため、非 loopback は `allowRemote = true` を明示しない限り load 時に `ConfigError`。opt-in 時は doctor / 起動 WARN で remote egress を開示
- `baseUrl` / `maxBytes` / `maxTextChars` / `version` は markitdown backend に適用。**`maxBytes` は入力バイト数、`maxTextChars` は抽出後テキスト長**で、測る量が違うため別 knob（[#529](https://github.com/ozzy-labs/suasor/issues/529)）。`version` を bump すると `extraction_meta` の記録と差分（drift）し、既存 source が次の `sync` で自動再抽出される（ADR-0024 §6・`suasor extraction status` で可視化）。未知キーは保持（`passthrough`）

### `[export]`（確定・ADR-0025）

```toml
[export]
# dir = "/absolute/path/to/exports"  # draft.export の sandbox（既定 <configDir>/exports）

[export.composition]
backend = "disabled"   # disabled（既定）| pandoc — md→Office 変換サイドカー（#138）
# baseUrl = "http://localhost:8930"   # pandoc サイドカー（/compose を付加）
# allowRemote = false                 # 非 loopback baseUrl のとき true 必須（Issue #436・egress opt-in）
```

- `draft.export`（[ADR-0025](../adr/0025-local-draft-export.md)）が下書きを書き出すローカル sandbox。**送信しない・source に書き戻さない**（local-first / no-egress）
- `dir` 既定は `<configDir>/exports/`（loader が解決、`[storage].dbPath` と同様）。書き込みは `dir` 配下のみ（filename は basename・traversal 拒否）
- **`[connectors.local].roots` の配下/一致は不可**（書き出した下書きが再取り込みされるループ防止）。`draft.export` が realpath 解決して拒否する
- **Office 形式（docx/pptx/xlsx）の合成サイドカー `composition.baseUrl` は loopback allowlist（`localhost` / `127.0.0.0/8` / `::1`）でゲート**（Issue #436・[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）。pandoc は下書き本文全体を送るため、非 loopback は `composition.allowRemote = true` を明示しない限り load 時に `ConfigError`。opt-in 時は起動 / doctor / validate-config が remote egress を WARN で開示し、`draft.export` は結果に `composedViaRemoteSidecar: true` を返して HITL 承認へ egress を可視化する（md/txt はサイドカー不要・egress なし）

### `[tasks]`（確定・ADR-0036・改訂 R1）

```toml
[tasks]
default = "github"          # 新規 publish の既定行き先（github | jira | slack）。未設定＝null
# slackListExcludeFromIngest = true   # Slack 専用 list を取り込みスコープから除外（ループ防止・既定 true）

# --- 起票先ごとの typed ホーム（destination ごとに独立設定・共存可）---

[tasks.homes.github]
repo = "owner/repo"          # 起票先リポジトリ（本物の Issue）
# --- 任意：作成した Issue を Projects v2 board にも載せる ---
# project = "PVT_..."          # 追加先 Projects v2 board の node id
# statusFieldId = "PVTSSF_..." # complete/reopen で動かす単一選択 Status フィールド（project 固有）
# doneOptionId  = "..."        # complete で設定する Status option
# todoOptionId  = "..."        # reopen で設定する Status option

# [tasks.homes.jira]          # 本物の Jira issue を起票（host は read connector と同じ値＝identity 一致が前提）
# host = "example.atlassian.net"  # read [connectors.jira].host と同じ bare host
# project = "ENG"                 # プロジェクトキー
# email = "me@example.com"        # Cloud basic 認証用（非 secret。token は jira-actuator secret）
# auth = "basic"                  # basic（Cloud・既定）| bearer（self-hosted PAT）
# issueType = "Task"              # 起票する issue type（既定 Task）
# doneTransitionId = "31"         # complete で適用する workflow transition（workflow 固有）
# reopenTransitionId = "11"       # reopen で適用する workflow transition
# dropTransitionId = "51"         # drop(Won't Do)で適用する transition（任意・未設定は no-op+warn）

# [tasks.homes.slack]         # Slack List に起票（列/option id は list 固有＝config 駆動）
# list = "L0123"                  # 起票先 list id
# team = "T0123"                  # 任意。pool から優先する workspace（auth.test 照合・ADR-0042 決定 7）
# slackTitleColumnId = "..."      # title 列 / slackStatusColumnId / slackDoneOptionId / slackTodoOptionId
# slackDroppedOptionId = "..."    # drop 用（任意）/ slackCheckboxColumnId / slackMarkerColumnId
#                                 # read-back（ADR-0036 §6）には同 list を `[connectors.slack].lists` にも
#                                 # 追加して取り込む（lists:read scope。専用 list の取り込み除外とは排他）。
#                                 # token は pool（`connector:slack:tokens`）から到達性で選ぶ（ADR-0042）
```

- 確定 task を起票する**外部ホームは destination ごとに独立**（[ADR-0036](../adr/0036-task-external-home.md) §改訂 R1）。`[tasks].default` が**新規 publish の既定行き先**、`[tasks.homes.<destination>]` が各ホームの typed 設定
- **R1-2**: `task.publish` に任意 `destination` 引数（省略時 `default`）。publish は元々 per-task の HITL 呼び出しなので任意引数は摩擦にならない
- **R1-3（重要）**: 公開済み task の `task.act` / `task.update`（公開済み分岐）/ read-back は、その task **自身の `published_destination`** に対応する `[tasks.homes.<destination>]` で config を解決する。`default` は新規 publish にのみ使う ⇒ **既定を乗り換えても既存の published task の操作/読み戻しは壊れない**（Slack は externalId 内 listId で列/option マップ解決）
- **R1-4**: **未 publish タスクは private tier として正式**（外部 home 不要）。`propose.apply` の `publish` は既定 false、`task.update` のローカル分岐でローカルのみ遷移でき、`task.list` / brief 等の読み系は published task と同格に扱う。「private はホームの選び方で対応」は撤回
- `default`（または引数の destination）に対応する `[tasks.homes.<dest>]` 未設定で `task.publish` / `task.act` を呼ぶと構造化エラー `ACTUATOR_NOT_CONFIGURED`（起動時致命にしない＝per-call degrade、`[export].dir` 未設定と同型）
- egress には read connector と**別スコープ（write）のトークン**が要る（GitHub `issues:write` 等）。secret は `<destination>-actuator` 名で keychain/env 管理

#### 移行（R1 破壊的変更）

R1 は後方互換を要求しない破壊的 config 変更。旧 `[tasks.home]`（destination フィールド + flat な各種フィールド）を廃し、以下へ移行する:

1. 旧 `[tasks.home].destination` の値を `[tasks].default` に移す（例 `default = "github"`）
2. 旧 `[tasks.home]` の各フィールドを、その destination の `[tasks.homes.<destination>]` テーブルへ移す（`destination` フィールド自体は削除）。github の flat フィールド（`repo` / `project` / `statusFieldId` / `doneOptionId` / `todoOptionId`）は `[tasks.homes.github]` へ、jira の（`host` / `project` / `email` / `auth` / `issueType` / `doneTransitionId` / `reopenTransitionId` / `dropTransitionId`）は `[tasks.homes.jira]` へ、slack の（`list` / `slack*ColumnId` / `slack*OptionId`）は `[tasks.homes.slack]` へ
3. 複数ホームを併用したい場合は `[tasks.homes.github]` と `[tasks.homes.jira]` を両方書き、`default` で既定を選ぶ。`task.publish destination=<dest>` で個別に振り分けられる

### `[digest]`（確定・ADR-0040）

```toml
# proactive push lane（cron one-shot・no daemon）。名前付き recurring job を並べる。
# job が 1 件も無ければ digest は何も送らない（事前同意のない通知なし）。
[[digest.jobs]]
name = "morning"           # job 名。--job <name> で選択、file チャネル既定出力名（<name>.md）
channel = "file"           # os-notification | file | slack-dm
limit = 10                 # priority scorer 上位 N（既定 10・ADR-0041）
# schedule = "0 8 * * *"   # cron 式（案内用）。実際の起動は OS scheduler が担う（runtime は評価しない）
# filename = "morning.md"  # file チャネル：export sandbox 内の basename（既定 <name>.md）
```

- **proactive push lane**（[ADR-0040](../adr/0040-proactive-push-lane.md)）。`suasor digest` を cron から 1 回起動し、構成済み job ごとに priority scorer 上位 N（[ADR-0041](../adr/0041-neutral-demand-priority-substrate.md)）+ brief warnings を bundle・render してチャネルへ送る。要約生成はしない（ML 委譲 [ADR-0006](../adr/0006-ml-delegation.md)）
- **standing consent（定常同意）**: job を構成する行為が承認。job が空なら一切出力しない（unsolicited 通知の禁止は維持・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) の per-event HITL は write tool に対して不変）
- **チャネル**: `file` は `[export].dir` sandbox 配下へ書く（[ADR-0025](../adr/0025-local-draft-export.md)・basename・local root 直下不可）/ `os-notification` は OS 通知（osascript / notify-send / PowerShell）/ `slack-dm` は actuator 経路で自分宛て DM（[ADR-0036](../adr/0036-task-external-home.md)・token は pool から bounded failover（先頭 +1 枚、[ADR-0042](../adr/0042-slack-workspace-less-connector.md) 決定 7）・self id は `[connectors.slack].self_user_ids`・失敗は構造化エラー）
- **cadence** は OS scheduler（cron / launchd / systemd）が持つ（[ADR-0027](../adr/0027-bulk-sync-orchestration.md)・no daemon）。導線は [scheduling guide](../guide/scheduling.md)

### 他セクション（後続 Issue が拡張）

```toml
[connectors.<name>]
# connector 固有設定（対象 / cursor 挙動 / since 等）。トークンは書かない（keychain/env）

[connectors.github]                      # GitHub connector（実装済み・docs/guide/connectors.md）
repos = ["owner/repo"]                    # 取り込み対象
state = "all"                             # open | closed | all（既定 all）
notifications = "off"                     # off | all | repos（既定 off・per-token 通知 stream）
# baseUrl = "https://github.example.com/api/v3"  # GitHub Enterprise
```

- **`[llm]` は廃止**（[ADR-0006](../adr/0006-ml-delegation.md) 決定 4 / [#529](https://github.com/ozzy-labs/suasor/issues/529)）。**Suasor は LLM を呼ばない — LLM は host そのもの**（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。かつては `anthropic` / `openai` / `ollama` という**それらしく見えるが何も読まれない**選択肢を持ち、`suasor init` が全 config に書き込んでいた。既存 config が壊れないよう schema 上は受理を続けるが、**節が書かれていれば「削除してください」と WARN を出す**（起動時 / `doctor` / `validate-config`）。削除すれば警告も消える
- `[connectors.<name>]` の root は open record だが、`loadConfig` が**各 connector の per-connector スキーマ（`src/connectors/<name>.ts` の `*ConnectorConfig`）で load 時に slice を検証**する（registry 経由・[ADR-0007](../adr/0007-connector-contract.md)）。検証は **strict**（未知キー拒否）で、`repos` を `repo` と打つ等の typo・型不一致は load 時に `ConfigError` として fail-fast する（従来は sync 時に黙って空振り）
  - **未知キーは拒否**（strict）。connector 固有の追加項目は connector スキーマ側で受理を宣言する（root の `passthrough` には頼らない）
  - 例外として `enabled`（任意の boolean）は**全 connector slice 共通の制御キー**として常に受理される（`enabled = false` で sync 対象から除外。`connectors list` / `doctor` / `sync` と同一規約）。connector 固有スキーマには含めず loader が一律にマージする
  - **スキーマ未提供 connector / 未登録 connector のキーは lenient**（緩く保持・段階導入可）。後方互換のため、既存の正しい config はそのまま通る
  - スキーマ参照は registry の lazy import で行い、設定された slice の connector モジュールのみを読む（import-clean を維持・重い SDK を eager import しない、NFR-PRF-1）

## env

- `SUASOR_*` 接頭辞。`__`（ダブルアンダースコア）で section をネスト（例: `SUASOR_EMBEDDING__BACKEND=ollama` → `embedding.backend`）。CI / headless で TOML を上書き
- 値は `true` / `false` / 数値を自動コアース、それ以外は文字列
- `SUASOR_CONFIG_DIR` は設定ディレクトリ解決にのみ使い、config 値には載せない
- secrets の env override: `SUASOR_CONNECTOR_<NAME>_<SECRET>`（大文字化・非英数は `_`。例: `SUASOR_CONNECTOR_GITHUB_TOKEN`）。env > keychain の優先順位（`src/connectors/secrets.ts`）

## 規約

- 不正値は起動時に fail-fast（`ConfigError`。Zod issues を field 単位で保持）
- レイヤは deep-merge してから Zod で検証（init args > env > file > defaults）

## 実効値の確認

合成後の実効 config（`env override > file > defaults`）は `suasor config show [--effective] [--json]` で確認する（[cli design](cli.md) の `config show`）。secret は**常にマスク**（`***`）され、connector の資格情報は**存在有無のみ**（`set` / `unset`）を出す（NFR-PRV-4）。`doctor`（健全性診断）とは責務分離で、`config show` は「今どの値が効いているか」を出す。

## multi-account（`[connectors.<name>.accounts.<account>]`・ADR-0050 / #441）

個人アカウントと仕事アカウントの mail / calendar / files を 1 install で取り込む。対応 connector は **`google` / `ms-graph`**（manifest の `multiAccount` が宣言し、completeness test が config schema と突き合わせる）。

```toml
[connectors.google]
clientId = "shared.apps.googleusercontent.com"   # 全 account が継承する既定値
resources = ["gmail", "calendar"]

[connectors.google.accounts.personal]
self_addresses = ["me@personal.example"]

[connectors.google.accounts.work]
calendarId = "me@work.example"                    # override
resources = ["gmail", "calendar", "drive"]
self_addresses = ["me@work.example"]
```

- **`accounts` が無ければ従来どおり**: flat キーがそのまま `default` という 1 アカウントになる。既存 config は無改修で動く
- **`accounts` があれば flat キーは継承の既定値**になり、それ自体は取り込まれる account では**なくなる**。従来の flat 設定を残したまま account を足すときは `[connectors.<name>.accounts.default]`（**空テーブルで可**・flat を継承）も書く。書き忘れは `doctor` の `connectors.accounts` が指摘する
- account 名は `[A-Za-z0-9][A-Za-z0-9_-]*`。**env override 名が衝突する組（`work-a` と `work_a`）は load 時に拒否**される
- account テーブル内も **strict**（未知キーは load 時に `ConfigError`）

### secret / externalId の命名

| | `default` account | 名前付き account（例 `work`） |
| --- | --- | --- |
| keychain account | `connector:google:refreshToken` | `connector:google:work:refreshToken` |
| env override | `SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN` | `SUASOR_CONNECTOR_GOOGLE_WORK_REFRESHTOKEN` |
| externalId | `google:<resource>:<id>` | `google:work:<resource>:<id>` |

`default` を無印に保つのは**既存 install を無移行にする**ため（keychain / env / 取り込み済み source lineage がそのまま生きる）。名前付き account の externalId を名前空間化するのは **correctness 要件**で、Gmail の message id はメールボックス内でしか一意でなく、Calendar の event id は同じ会議が各出席者のカレンダーで同じ値を持つ（名前空間化しないと 1 件の会議が 1 本の source を取り合う）。**account の rename は identity の変更**であり、旧 id の source は残ったまま新 id で再取り込みになる。

credential の保管は `suasor <connector> auth set --account <name>`、検証は `suasor <connector> auth test [--account <name>]`（省略時は全 account）。詳細は [cli design](cli.md) と [connectors guide](../guide/connectors.md#multi-account取り込みgoogle--ms-graph)。

## `[connectors.google]` / `[connectors.ms-graph]` の `self_addresses`（#488）

```toml
[connectors.google]
self_addresses = ["me@example.com", "me@old-domain.com", "team@example.com"]
```

email demand（自分宛ての未返信スレッド・[ADR-0043](../adr/0043-email-demand-signals.md)）の「自分」を定める。**未設定なら email demand は常に空**（Slack の `self_user_ids` と同じ形）で、`doctor` が警告する。multi-account では **account をまたいで union** され（「自分」は 1 人）、`doctor` の警告も account ごとに出る（[ADR-0050](../adr/0050-multi-account-connectors.md) 決定 7）。

**API から自動導出しない**のは、エイリアス・旧アドレス・配布リスト（`team@`）も実務上「自分宛て」であり、プロフィール API が返す単一の主アドレスでは取りこぼすため。

## connector の必須設定（`requiredSettings`・ADR-0049 / #478）

一部の connector は、credential とは別に**非 secret の設定キー**が無いと API を名指しできない:

| connector | 必須キー | 用途 |
| --- | --- | --- |
| `google` | `clientId` | desktop / web app の OAuth client id |
| `ms-graph` | `tenantId` / `clientId` | Azure AD tenant（directory）id / app registration の client id |
| `jira` | `host` | Jira site host（scheme なし。例 `example.atlassian.net`） |

これらは schema 上 `.default("")` を持つため**空でも load を通る**（`enabled = true` だけの slice が `loadConfig` も `validate-config` も通過する）。従来はその状態が sync 時にベンダ側の不透明なエラーとして初めて現れていたので、`suasor doctor` が `connectors.config` の **ERROR** として先に surface する（[ADR-0049](../adr/0049-connector-readiness-parity.md) 決定 2）。取り込み対象が空（`connectors.noop`・WARN）とは**別の行**で、severity も対処も違う。宣言先は connector manifest の `requiredSettings`（`src/connectors/manifest.ts`）。

## `[sync]` — 取り込み鮮度の期待値（#442）

```toml
[sync]
expectedIntervalHours = 24   # 期待する sync 間隔（既定 24）
safetyFactor = 2             # 閾値 = expectedIntervalHours × safetyFactor（既定 2）

[sync.perConnectorIntervalHours]
box = 168                    # connector 個別の上書き（時間）
```

- Suasor は自分をスケジュールしない（[ADR-0027](../adr/0027-bulk-sync-orchestration.md)）ので、cadence を**知り得ない**。この設定は「どれだけ経ったら遅れているとみなすか」を明示するためのもの
- 判定結果は `suasor doctor` の `sync.freshness` チェック、`brief` / `digest` の `sync_stale` warning、MCP `sync.status` tool の 3 経路で surface する（[運用ガイド](../guide/scheduling.md)）
- 既定を日次にしているのは、1 回の取りこぼし（スリープ中の cron 等）で警告を出すと読まれない警告になるため
- `perConnectorIntervalHours` のキーは**登録済み connector 名でなければ fail-fast**（`ConfigError`）。record は任意キーを受けるため、typo（`gihub = 168`）を許すと本物の connector が既定閾値のまま放置され、「変えたつもりの閾値」で警告が出る／出ないという silent wrong answer になる（`[connectors.*]` の strict 検証と同じ規律）
