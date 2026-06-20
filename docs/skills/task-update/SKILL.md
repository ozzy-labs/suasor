---
name: task-update
description: 「これ終わった」「完了にして」「task を進行中に」「これは見送り」「task を再開」「あのタスク done」と頼まれたら、Suasor MCP の task.list で対象 task を特定し、ユーザー確認後に task.update で lifecycle 状態（open / in_progress / completed / dropped）を遷移させる。auto-apply 経路は存在しない。
readOnly: false
category: task
triggers:
  - これ終わった
  - 完了にして
  - task を進行中に
  - これは見送り
  - task を再開
  - あのタスク done
pairs: []
mcp_tools_read:
  - task.list
mcp_tools_write:
  - task.update
---

# task-update

task の lifecycle 状態を遷移させる HITL write skill。`task.create` が task を開き（`proposed`）`task.list` が読むのに対し、本 skill は `in_progress` / `completed` / `dropped` への前進（および再開）を担う（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。`next-actions` / `external-brief` が読む `state` を実際に動かす経路。

## いつ発火するか

- 「これ終わった」「完了にして」「あのタスク done」（→ `completed`）
- 「task を進行中に」「着手した」（→ `in_progress`）
- 「これは見送り」「やめる」（→ `dropped`）
- 「task を再開」「やっぱりやる」（→ `open` / `in_progress`）

## 何をするか（MCP tool flow）

read で特定して、write は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `task.list`（`state` で絞り可、`updatedAfter` / `updatedBefore` で期間絞り）で対象 task を特定する。各 task は `id` / `title` / `state` / `updated_at`
2. どの task をどの状態にするか**ユーザーに提示して確認を取る**（native framing: ホスト側で人の承認を促す）
3. 承認後、`task.update`（`taskId` / `state`）で遷移させる（`TaskApplied` を append → `tasks` projection）。state 語彙: `open` / `in_progress` / `completed` / `dropped`

## 制約

- HITL。人の承認なしに `task.update` を呼ばない。auto-apply しない。`task.list` は read（特定）
- idempotent: 同じ state への遷移は no-op（`unchanged`、event を append しない）。存在しない task は `missing`（status で報告、throw しない）
- lifecycle に禁止遷移は無い（`completed` の task を `in_progress` に戻す等も可）。新規 task の作成は `task.create`（別 skill / 経路）
- 本 skill は手順書のみで実処理を持たない
