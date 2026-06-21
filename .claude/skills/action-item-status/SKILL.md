---
name: action-item-status
description: 「あの会議から何が実装されたか」「会議で決めた action item の進捗」「先週の MTG のフォロー結果」「会議由来の task はどうなった」「決めたことの実装状況」と聞かれたら、Suasor MCP の source.list（calendar source）+ graph.related（会議由来の task / decision）+ task.list（state）を読み取り系で組み合わせ、会議で決めた action item の実装進捗を返す。read-only。
readOnly: true
category: meeting
triggers:
  - あの会議から何が実装されたか
  - 会議で決めた action item の進捗
  - 先週の MTG のフォロー結果
  - 会議由来の task はどうなった
  - 決めたことの実装状況
pairs:
  - meeting-followup
mcp_tools_read:
  - source.list
  - graph.related
  - task.list
mcp_tools_write: []
---

# action-item-status

会議で決めた action item の **実装進捗**を追う read skill。「あの会議から何が実装されたか」を read-only で組み立てる（[ADR-0008](../../adr/0008-assistant-skills.md) の skill 設計）。**新 MCP tool は不要**で、既存 read tool の合成で実現する。pair: 候補生成側の [meeting-followup](../meeting-followup/SKILL.md)（会議 → task/decision 候補）の **後工程**にあたる。

## いつ発火するか

- 「あの会議から何が実装されたか」「会議で決めた action item の進捗」
- 「先週の MTG のフォロー結果」「会議由来の task はどうなった」「決めたことの実装状況」

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。副作用なし・エージェント自律 OK。**専用 tool は追加しない**（既存合成、[ADR-0008](../../adr/0008-assistant-skills.md)）。

1. 対象会議を特定する。`source.list`（calendar の `sourceType`、`observedAfter` / `observedBefore` で対象期間）で該当 calendar event を引く（ms365_calendar / google_calendar、[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）
2. 各会議 source を起点に `graph.related` で **会議由来の task / decision** へ `links` を辿る（[meeting-followup](../meeting-followup/SKILL.md) が `propose.apply` で保存した `TaskProposed` / `DecisionRecorded` が provenance でつながっている、[data-model.md](../../design/data-model.md)）
3. 辿った task について `task.list`（`state` 指定）で現在の lifecycle 状態（open / in_progress / completed / dropped）を引き、実装が進んだか / 残っているかを判定する（[ADR-0028](../../adr/0028-task-scheduling-fields.md)）
4. ホスト LLM が「会議で決めた action item ↔ 由来 task の現状態」を突き合わせ、実装済み / 進行中 / 未着手 / 見送り に分類した進捗サマリを組み立てて返す

## meeting-followup との関係（前後ペア）

- [meeting-followup](../meeting-followup/SKILL.md): 会議**後**に task / decision 候補を生成する（HITL write）
- action-item-status: 生成・保存された action item が**その後どこまで実装されたか**を追う（read）

会議由来 task の状態を実際に遷移させたい場合は、本 skill では書かず [task-update](../task-update/SKILL.md) へ HITL で橋渡しする（auto-apply なし、[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

## 制約

- read-only。persist しない（イベントを書かない）。状態遷移は [task-update](../task-update/SKILL.md) へ HITL 橋渡しし、本 skill 内で write tool を呼ばない
- 時間窓は下限 inclusive `*After` / 上限 exclusive `*Before`
- 本 skill は手順書のみで実処理を持たない
