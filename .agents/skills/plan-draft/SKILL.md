---
name: plan-draft
description: 「これを分解して」「設計のたたき台」「計画に落として」「タスクに分解」「この issue を計画化」「進め方を考えて」と頼まれたら、Suasor MCP の source.get / recall.search で起点（issue・設計メモ・source）の文脈を集め、propose.generate（mode=source_extract）で task / decision 候補に分解し、ユーザー確認後に propose.apply で承認分のみ保存する。計画ドラフト本文は text-only で返し persist しない。auto-apply 経路は存在しない。
---

# plan-draft

起点（issue / 設計メモ / source）を「計画」に落とす HITL write skill。「計画する」動詞を担い、文脈を集めて task / decision 候補に**分解**し、承認分のみ保存する（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。`next-actions`（既存 task の列挙）に対し、本 skill は**新しい計画の生成・分解**側。

## いつ発火するか

- 「これを分解して」「タスクに分解」「この issue を計画化」
- 「設計のたたき台」「進め方を考えて」「計画に落として」

## 何をするか（MCP tool flow）

read で文脈を集め、計画本文は text-only、task/decision 化は HITL（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. 起点の文脈を集める: `source.get`（対象 issue/メモの本文）/ `recall.search`・`search`（関連やりとり）/ `graph.related`（関連 decision・先行仕様）。広く調べるなら `research` skill を併用
2. 分解方針・マイルストーン・順序/依存の**計画ドラフト本文を host LLM が構成して返す**（text-only・persist しない。handoff-draft / announcement-draft と同じ作法）
3. 計画中の実行項目を `propose.generate`（mode=`source_extract`）で **task / decision 候補に分解**する（`source_extract` の許可 kind = `task` / `decision` / `reply_draft`）
4. `propose.list`（`state=pending`）で候補を提示し、**ユーザー確認**を取る
5. 承認分のみ `propose.apply` で保存（idempotent）。不要な候補は `propose.reject`（任意で理由）

## 制約

- HITL。人の承認なしに `propose.apply` を呼ばない。auto-apply しない。計画ドラフト本文は persist しない
- task 間の順序/依存は当面**計画本文のサマリで提示**し、task 自体は個別に作成する（順序メタを持つ専用 `plan` mode は将来拡張・別 issue）
- 既存 task の状態確認/列挙は `next-actions`、完了遷移は `task-update` を使う
- 本 skill は手順書のみで実処理を持たない
