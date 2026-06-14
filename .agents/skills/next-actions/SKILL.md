---
name: next-actions
description: 「次に何をする?」「やること教えて」「タスク何が残ってる?」「今日やること」「優先度高いのは?」と聞かれたら、Suasor MCP の task.list と recall.search を使って優先度順の next-actions を組み立てる。新規 task 作成は write tool（task.create）のためホスト側で人確認を促す。
---

# next-actions

未処理 task を優先度順に並べて「次にやること」を返す。

## いつ発火するか

- 「次に何をする?」「やること教えて」「タスク何が残ってる?」
- 「今日やること」「今週やること」「来週やること」「優先度高いのは?」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `task.list`（`state=open` / `state=in_progress`）で未完 task を取る。期間指定があれば `updatedAfter` / `updatedBefore`（ISO 8601、`tasks.updated_at` ベース）でフィルタする
2. `recall.search` で各 task に関連する context を補強する（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
3. ホスト LLM が緊急度・依存・期日から優先度順に並べて next-actions を組み立てて返す

## 制約

- read-only。task の状態を変えない
- **新規 task の作成は `task.create`（write tool）のため、ここでは行わず、ホスト側で人の確認を促す**（HITL、auto-apply なし、[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）
- 本 skill は手順書のみで実処理を持たない
