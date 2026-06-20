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
- encryption 等の追加項目は将来 Issue で拡張

### `[embedding]`（確定）

```toml
[embedding]
backend = "disabled"   # disabled（既定）| ollama | openai | voyage（local=in-process は不採用）
baseUrl = "http://localhost:11434"  # ollama サイドカー。/api/embed は client が付与
model = "bge-m3"                     # 埋め込みモデル。ingest と query で同一（ベクトル空間整合）
dim = 1024                           # 埋め込み次元。model の出力次元と一致必須（bge-m3=1024）
```

- `backend` 既定 `disabled`（base install を軽く保つ）。`recall.search` は無効時に空 + `embedding_disabled` シグナルで FTS に degrade（[retrieval](retrieval.md) / [ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
- 現状 `ollama` のみ実装。`openai` / `voyage` は config 上受理するが未実装（embedder は `null` ＝ degrade）
- `baseUrl` / `model` は ollama backend に適用。`model` は **ingest（文書）と query（クエリ）で必ず同一**（混在すると recall が静かに劣化するため、単一値が両方を駆動）。既定 `bge-m3`（多言語・1024 次元）
- `dim` は埋め込みベクトルの次元で、`model` の出力次元と一致必須（`bge-m3`=1024、例: `nomic-embed-text`=768）。DB 作成時に vec0 テーブルのサイズを決めるため、既存ストアで変えるには新規 DB（または delete + rebuild + 再 sync）が必要。不一致だと全ベクトル挿入が失敗し recall が静かに空へ degrade するため、非 1024 次元 model を使うときは必ず設定する
- 未知キーは保持（`passthrough`）し、backend 固有項目を後続が確定する
- env override 例: `SUASOR_EMBEDDING__BACKEND=ollama` / `SUASOR_EMBEDDING__MODEL=bge-large` / `SUASOR_EMBEDDING__BASEURL=http://sidecar:11434`

### `[extraction]`（確定・ADR-0024）

```toml
[extraction]
backend = "disabled"   # disabled（既定）| markitdown
# baseUrl = "http://localhost:8929"   # markitdown sidecar（/extract を付加）
# maxBytes = 5000000                  # 抽出テキストの上限。超過は name-only に degrade
# version = "1"                       # extractor version。bump で既存 source を次 sync で再抽出
```

- Office/PDF（docx/xlsx/pptx/pdf）本文を text/Markdown 化する任意のサイドカー（[ADR-0024](../adr/0024-document-extraction-sidecar.md)）。既定 `disabled` で、無効時は従来どおり name-only（取り込みは成功）
- ML 委譲（[ADR-0006](../adr/0006-ml-delegation.md)）: 変換はサイドカー、本体は thin client のみ（in-process パーサ無し）。失敗は best-effort で warning + name-only fallback
- 初期スコープは **`local` connector 限定**（box/drive(API) は内容 fetch + 内容 fingerprint を要する後続 Issue で段階化）
- `baseUrl` / `maxBytes` / `version` は markitdown backend に適用。`version` を bump すると `extraction_meta` の記録と差分（drift）し、既存 source が次の `sync` で自動再抽出される（ADR-0024 §6・`suasor extraction status` で可視化）。未知キーは保持（`passthrough`）

### `[export]`（確定・ADR-0025）

```toml
[export]
# dir = "/absolute/path/to/exports"  # draft.export の sandbox（既定 <configDir>/exports）

[export.composition]
backend = "disabled"   # disabled（既定）| pandoc — md→Office 変換サイドカー（#138）
# baseUrl = "http://localhost:8930"   # pandoc サイドカー（/compose を付加）
```

- `draft.export`（[ADR-0025](../adr/0025-local-draft-export.md)）が下書きを書き出すローカル sandbox。**送信しない・source に書き戻さない**（local-first / no-egress）
- `dir` 既定は `<configDir>/exports/`（loader が解決、`[storage].dbPath` と同様）。書き込みは `dir` 配下のみ（filename は basename・traversal 拒否）
- **`[connectors.local].roots` の配下/一致は不可**（書き出した下書きが再取り込みされるループ防止）。`draft.export` が realpath 解決して拒否する

### 他セクション（後続 Issue が拡張）

```toml
[llm]
backend = "disabled"   # disabled | anthropic | openai | ollama

[connectors.<name>]
# connector 固有設定（対象 / cursor 挙動 / since 等）。トークンは書かない（keychain/env）

[connectors.github]                      # GitHub connector（実装済み・docs/guide/connectors.md）
repos = ["owner/repo"]                    # 取り込み対象
state = "all"                             # open | closed | all（既定 all）
notifications = "off"                     # off | all | repos（既定 off・per-token 通知 stream）
# baseUrl = "https://github.example.com/api/v3"  # GitHub Enterprise
```

- `[embedding]` は確定（上記）。`[llm]` は未知キーを保持（`passthrough`）し、backend 固有項目を後続 Issue が確定する
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
