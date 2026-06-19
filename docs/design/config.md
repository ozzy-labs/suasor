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
- `[connectors.<name>]` は open record（foundation では値を緩く保持）。各 connector が自身の slice を Zod 検証する（例: `[connectors.github]`）

## env

- `SUASOR_*` 接頭辞。`__`（ダブルアンダースコア）で section をネスト（例: `SUASOR_EMBEDDING__BACKEND=ollama` → `embedding.backend`）。CI / headless で TOML を上書き
- 値は `true` / `false` / 数値を自動コアース、それ以外は文字列
- `SUASOR_CONFIG_DIR` は設定ディレクトリ解決にのみ使い、config 値には載せない
- secrets の env override: `SUASOR_CONNECTOR_<NAME>_<SECRET>`（大文字化・非英数は `_`。例: `SUASOR_CONNECTOR_GITHUB_TOKEN`）。env > keychain の優先順位（`src/connectors/secrets.ts`）

## 規約

- 不正値は起動時に fail-fast（`ConfigError`。Zod issues を field 単位で保持）
- レイヤは deep-merge してから Zod で検証（init args > env > file > defaults）
