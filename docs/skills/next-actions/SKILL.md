---
name: next-actions
description: 「次に何をする?」「やること教えて」「タスク何が残ってる?」「今日やること」「優先度高いのは?」と聞かれたら、Suasor MCP の priority.list（決定論的 cross-entity scorer）を基線に、tasks + open commitments + un-acked demand を優先度順に並べた next-actions を返す。順位はコードが固定し、会話文脈での上書きだけを host が担う。新規 task 作成は write tool（task.create）のためホスト側で人確認を促す。
readOnly: true
category: task
triggers:
  - 次に何をする?
  - やること教えて
  - タスク何が残ってる?
  - 今日やること
  - 優先度高いのは?
pairs:
  - brief
mcp_tools_read:
  - search
  - priority.list
  - task.list
  - demand.list
  - commitment.list
mcp_tools_write: []
---

# next-actions

未処理 task / 約束 / demand を優先度順に並べて「次にやること」を返す。順位の基線は **コードが持つ**（`priority.list` の決定論的 scorer、[ADR-0041](../../adr/0041-neutral-demand-priority-substrate.md)）。skill 散文で順位を決めない。

## いつ発火するか

- 「次に何をする?」「やること教えて」「タスク何が残ってる?」
- 「今日やること」「今週やること」「来週やること」「優先度高いのは?」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. **`priority.list` を基線として取る**（[ADR-0041](../../adr/0041-neutral-demand-priority-substrate.md) 決定 3 / [ADR-0045](../../adr/0045-priority-ranking-model.md)）。open/in_progress な task + open commitment + **un-acked demand** を 1 本のランク付きリストに合成した決定論的 scorer で、同一入力に対し順序が一定になる（テストで固定）。順序モデルはコードが持つ:

   **hard tier（開始 30 分以内の会議）> 重み付きスコア**（[ADR-0045](../../adr/0045-priority-ranking-model.md)）。スコアは超過日数 / 未返信日数 / demand の鮮度 / 期日接近 / 会議準備 / priority を合成する。**程度が効く** — 「3 週間超過」は「1 日超過」より上、期限を跨いでもスコアは下がらない

   各 item は `rank` / `entity` / `id` / `title` / `reason`（**最も寄与した項**: `starting_soon` / `overdue` / `aging` / `unacked_demand` / `due_soon` / `prep` / `priority` / `recency`）/ `explanation`（その項の一文）/ `score` / `record` を持つ。**根拠として提示するのは `explanation`**（「期限を 21 日超過」）であって `score` の数値ではない（[ADR-0045](../../adr/0045-priority-ranking-model.md) 決定 4）。`selfUserId` 未設定時 demand は DM のみ。
2. 必要に応じ各 entity の詳細を補う（基線の順位は変えない・表示補強のみ）:
   - `task.list`（`state=open` / `in_progress`、期間指定は `updatedAfter` / `updatedBefore`）で task の `dueDate` / `priority` / `overdue` を詳しく見る（[ADR-0028](../../adr/0028-task-scheduling-fields.md)）
   - `demand.list` で demand 行の `channelName` / `userName`（ローカル join した人間可読名・未解決は `null`＝生 id fallback、[ADR-0037](../../adr/0037-slack-name-enrichment.md) §10）や github notification の `source`/`kind`（reason）を見る。提示は **id ではなく名前**で行う。`source` は `slack` / `github` / `email`（未返信スレッド・[ADR-0043](../../adr/0043-email-demand-signals.md)）/ `calendar`（`meeting_soon` / `meeting_prep`・[ADR-0044](../../adr/0044-calendar-proximity-signals.md)）
   - `commitment.list`（`state=open`、`direction=owed_by_me` で自分が負う約束）で約束の相手/期日を見る（[ADR-0021](../../adr/0021-commitment-ledger.md)）
   - `search`（`mode=semantic`） で各項目に関連する context を補強（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
3. 基線の順序に沿って next-actions を提示する。**会話文脈による上書きは host の裁量**（例:「今日は Slack を無視して」→ demand tier を落とす）。上書きしない限り、順位は `priority.list` の基線に従う

## 制約

- read-only。task / demand の状態を変えない
- **順位決定はコード（`priority.list`）に委ねる**。skill 散文だけで並べ替えない（[ADR-0041](../../adr/0041-neutral-demand-priority-substrate.md)。会話文脈での上書きのみ host 裁量）
- **対応済み / 不要な demand は `demand.mark`（`state`）（write tool）で印を付ける**と基線から外れる。ここでは印付けを行わず、ホスト側で人の確認を促す（HITL、auto-apply なし、[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）
- **新規 task の作成は `task.create`（write tool）のため、ここでは行わず、ホスト側で人の確認を促す**（HITL、auto-apply なし）
- 本 skill は手順書のみで実処理を持たない
