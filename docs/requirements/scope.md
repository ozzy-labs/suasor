# Scope

## In scope

- ローカルファーストの取り込み（read 専用 connector）と event-sourced 記憶
- FTS-first 検索 + 任意の意味検索（Ollama サイドカー）
- 要約・助言・返信/タスク/決定の **提案**（HITL 適用）
- MCP server（read / write tool）+ アシスタント skill 群
- マルチエージェント（Claude Code / Codex / Gemini / Copilot）
- npm / 単一バイナリ / Docker 配布

## Out of scope（現時点で非目標）

- **外部 SaaS への無承認の書き戻し / 送信** — write はすべて per-event HITL（auto-apply / auto-send なし・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。**承認後の実行は Suasor が代行する**（`task.publish` / `task.act` 等の actuator・[ADR-0036](../adr/0036-task-external-home.md)）— 非目標なのは「無承認の egress」であって「代行実行」ではない
- **常時稼働の能動エージェント（daemon）** — 常駐プロセス・watcher は持たない（[ADR-0040](../adr/0040-proactive-push-lane.md)）。proactive な digest push は導入したが、それも **daemon ではなく cron one-shot**（`suasor digest`・OS scheduler 起動）で、**事前構成した名前付き job（standing consent）が無ければ一切送らない**（[ADR-0027](../adr/0027-bulk-sync-orchestration.md) と同型・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) の per-event HITL は write tool に対して不変）。**同意なしの通知（unsolicited notification）**は引き続き非目標
- **重い in-process ML**（学習・自前モデル実行。委譲する）（[ADR-0006](../adr/0006-ml-delegation.md)）
- **マルチユーザー / チーム共有 / サーバ集約**（単一ユーザー・ローカル前提）
- Web / モバイル UI（境界は CLI / MCP）

> Out of scope 項目は将来 ADR で再評価しうる。現時点の製品像（ローカル優先の助言する秘書）を保つための線引き。
