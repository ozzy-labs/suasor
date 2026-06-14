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

### 他セクション（後続 Issue が拡張）

```toml
[embedding]
backend = "disabled"   # disabled | ollama | openai | voyage（local=in-process は不採用）
# ollama: base_url = "http://localhost:11434", model = "bge-m3"

[llm]
backend = "disabled"   # disabled | anthropic | openai | ollama

[connectors.<name>]
# connector 固有設定（対象 / cursor 挙動 / since 等）。トークンは書かない（keychain/env）

[connectors.github]                      # GitHub connector（実装済み・docs/guide/connectors.md）
repos = ["owner/repo"]                    # 取り込み対象
state = "all"                             # open | closed | all（既定 all）
# baseUrl = "https://github.example.com/api/v3"  # GitHub Enterprise
```

- `[embedding]` / `[llm]` は未知キーを保持（`passthrough`）し、backend 固有項目を後続 Issue が確定する
- `[connectors.<name>]` は open record（foundation では値を緩く保持）。各 connector が自身の slice を Zod 検証する（例: `[connectors.github]`）

## env

- `SUASOR_*` 接頭辞。`__`（ダブルアンダースコア）で section をネスト（例: `SUASOR_EMBEDDING__BACKEND=ollama` → `embedding.backend`）。CI / headless で TOML を上書き
- 値は `true` / `false` / 数値を自動コアース、それ以外は文字列
- `SUASOR_CONFIG_DIR` は設定ディレクトリ解決にのみ使い、config 値には載せない
- secrets の env override: `SUASOR_CONNECTOR_<NAME>_<SECRET>`（大文字化・非英数は `_`。例: `SUASOR_CONNECTOR_GITHUB_TOKEN`）。env > keychain の優先順位（`src/connectors/secrets.ts`）

## 規約

- 不正値は起動時に fail-fast（`ConfigError`。Zod issues を field 単位で保持）
- レイヤは deep-merge してから Zod で検証（init args > env > file > defaults）
