# Design

要件（[../requirements/](../requirements/)）と決定（[../adr/](../adr/)）から導出する仕様・設計。実装はこの設計に従う。

- [data-model.md](data-model.md) — event schema / projection
- [mcp-surface.md](mcp-surface.md) — MCP tool 一覧（read / write・HITL）
- [connector-contract.md](connector-contract.md) — connector interface
- [retrieval.md](retrieval.md) — FTS-first 検索 + embedding サイドカー
- [cli.md](cli.md) — CLI コマンド
- [config.md](config.md) — 設定スキーマ

> 本ディレクトリは骨子。各 tool/connector/skill の詳細スキーマは実装 PR と並行して肉付けする（spec 先行・実装追従）。
