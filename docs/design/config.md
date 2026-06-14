# Config

Zod スキーマで定義。優先順位 **init args > env > 設定ファイル > defaults**。

## 場所
- 設定ディレクトリ: `~/.config/suasor/`（`SUASOR_CONFIG_DIR` で上書き）
- 設定ファイル: `config.toml`（編集は次回起動で反映）
- secrets: OS keychain（@napi-rs/keyring）。env override 経路あり（headless/Docker 用）

## 主なセクション（暫定）
```toml
[storage]
# db path / encryption など

[embedding]
backend = "disabled"   # disabled | ollama | openai | voyage（local=in-process は不採用）
# ollama: base_url = "http://localhost:11434", model = "bge-m3"

[llm]
backend = "disabled"   # disabled | anthropic | openai | ollama

[connectors.<name>]
# connector 固有設定（対象 / cursor 挙動 / since 等）
```

## env
- `SUASOR_*` 接頭辞（例: `SUASOR_EMBEDDING__BACKEND`）。CI / headless で TOML を上書き
- secrets の env override（例: `SUASOR_CONNECTOR_<NAME>_TOKEN`）

## 規約
- 不正値は起動時に fail-fast（ConfigError）
- 詳細スキーマは実装 PR で Zod として確定
