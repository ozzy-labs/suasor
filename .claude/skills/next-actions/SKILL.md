---
name: next-actions
description: 「次に何をする?」「やること教えて」「タスク何が残ってる?」「今日やること」「優先度高いのは?」と聞かれたら、Suasor MCP の task.list と recall.search を使って優先度順の next-actions を組み立てる。新規 task 作成は write tool（task.create）のためホスト側で人確認を促す。
readOnly: true
category: task
triggers:
  - 次に何をする?
  - やること教えて
  - タスク何が残ってる?
  - 今日やること
  - 優先度高いのは?
pairs: []
mcp_tools_read:
  - task.list
  - recall.search
  - slack.demand.list
  - commitment.list
mcp_tools_write: []
---

# next-actions

未処理 task を優先度順に並べて「次にやること」を返す。

## いつ発火するか

- 「次に何をする?」「やること教えて」「タスク何が残ってる?」
- 「今日やること」「今週やること」「来週やること」「優先度高いのは?」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `task.list`（`state=open` / `state=in_progress`）で未完 task を取る。期間指定があれば `updatedAfter` / `updatedBefore`（ISO 8601、`tasks.updated_at` ベース）でフィルタする。各 task は `dueDate` / `priority`（low / normal / high）と read 時派生の `overdue` を持つ（[ADR-0028](../../adr/0028-task-scheduling-fields.md)）。`overdue=true` で期限超過 task のみ、`dueBefore` で期日が近い task に絞れる
2. `slack.demand.list` で Slack の @mention / DM の未処理 signal を取り、「読むべきが未処理」を priority 上位の入力に含める（[ADR-0012](../../adr/0012-slack-demand-digest.md)）。`selfUserId` 未設定時は DM のみ
3. `commitment.list`（`state=open`）で未解決の commitment（約束/コミットメント）を取り、「能動的にやるべき約束」を priority 上位の入力に含める（[ADR-0021](../../adr/0021-commitment-ledger.md)）。`direction=owed_by_me` で自分が負う約束に絞れる
4. `recall.search` で各 task に関連する context を補強する（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
5. ホスト LLM が以下の優先度関数で並べて next-actions を組み立てて返す（[ADR-0028](../../adr/0028-task-scheduling-fields.md)）:

   **`overdue`（期限超過）> `slack.demand`（未処理 mention / DM）> `dueDate` 近接（期日が近い順）> `priority` 高（high > normal > low）> 更新新しさ（`updated_at` 新しい順）**

   overdue は「最も強い」やるべき signal として最上位に置く。期日のない task は priority と更新新しさで並べる

## 制約

- read-only。task の状態を変えない
- **新規 task の作成は `task.create`（write tool）のため、ここでは行わず、ホスト側で人の確認を促す**（HITL、auto-apply なし、[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）
- 本 skill は手順書のみで実処理を持たない
