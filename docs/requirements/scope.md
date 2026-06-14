# Scope

## In scope
- ローカルファーストの取り込み（read 専用 connector）と event-sourced 記憶
- FTS-first 検索 + 任意の意味検索（Ollama サイドカー）
- 要約・助言・返信/タスク/決定の **提案**（HITL 適用）
- MCP server（read / write tool）+ アシスタント skill 群
- マルチエージェント（Claude Code / Codex / Gemini / Copilot）
- npm / 単一バイナリ / Docker 配布

## Out of scope（現時点で非目標）
- **外部 SaaS への自動書き戻し / 自動送信**（HITL で人が行う。auto-apply/auto-send なし）（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）
- **常時稼働の能動エージェント / プロアクティブ通知**（初期は人/エージェント起点）
- **重い in-process ML**（学習・自前モデル実行。委譲する）（[ADR-0006](../adr/0006-ml-delegation.md)）
- **マルチユーザー / チーム共有 / サーバ集約**（単一ユーザー・ローカル前提）
- Web / モバイル UI（境界は CLI / MCP）

> Out of scope 項目は将来 ADR で再評価しうる。現時点の製品像（ローカル優先の助言する秘書）を保つための線引き。
