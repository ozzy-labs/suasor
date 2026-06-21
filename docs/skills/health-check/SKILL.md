---
name: health-check
description: 「健全性チェック」「今日のスナップショット」「滞留してるもの数えて」「全体の状態を数値で」「今どれくらい溜まってる」と頼まれたら、Suasor MCP の task.list（overdue / due<7d）+ propose.list（pending）+ inbox.list（open）+ commitment.list（open）を読み取り系で合成し、overdue task / 期日が近い task / 保留提案 / 未処理 inbox / 未解決 commitment を数値化した日次スナップショットを返す。read-only。
readOnly: true
category: task
triggers:
  - 健全性チェック
  - 今日のスナップショット
  - 滞留してるもの数えて
  - 全体の状態を数値で
  - 今どれくらい溜まってる
pairs: []
mcp_tools_read:
  - task.list
  - propose.list
  - inbox.list
  - commitment.list
mcp_tools_write: []
---

# health-check

今日の全体健全性を **数値スナップショット**で出す read skill。「何がどれくらい溜まっているか」を read-only で集計する（[ADR-0008](../../adr/0008-assistant-skills.md) の skill 設計）。**新 MCP tool は不要**で、既存 read tool の合成 + host 側集計で実現する。narrative の [personal-brief](../personal-brief/SKILL.md)・週次棚卸しの [weekly-review](../weekly-review/SKILL.md) に対し、本 skill は **日次の数値**に特化する。

## いつ発火するか

- 「健全性チェック」「今日のスナップショット」「全体の状態を数値で」
- 「滞留してるもの数えて」「今どれくらい溜まってる」

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。副作用なし・エージェント自律 OK。**専用 tool は追加しない**（既存合成、[ADR-0008](../../adr/0008-assistant-skills.md)）。派生指標（overdue / 期日が近い）は **host 側集計**で求める。

1. 基準時刻を「今」（ISO 8601 offset 付き）に置く
2. `task.list`（`state=open` / `state=in_progress`）で未完 task を引く:
   - `overdue=true` で期限超過 task を別枠で数える（read 時派生、[ADR-0028](../../adr/0028-task-scheduling-fields.md)）
   - `dueBefore`=今 + 7 日 で「期日が 7 日以内に近づいている」task を数える
3. `propose.list`（`state=pending`）で適用待ちの保留提案を数える（HITL 適用待ち、[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）
4. `inbox.list`（`state=open`）で未処理のまま open な inbox 項目を数える
5. `commitment.list`（`state=open`）で未解決の commitment を数える。必要なら `direction`（owed_by_me / owed_to_me）別に分けて数える（[ADR-0021](../../adr/0021-commitment-ledger.md)）
6. ホスト LLM が各カテゴリの件数を **数値スナップショット**としてまとめて返す（例: overdue task N 件 / 期日 7 日以内 M 件 / pending 提案 P 件 / open inbox Q 件 / open commitment R 件）

## 他 brief 系との違い

- [personal-brief](../personal-brief/SKILL.md): 直近 24h の **narrative** 要約（何が動いたか）
- [weekly-review](../weekly-review/SKILL.md): **週次**の棚卸し（残課題と落ちている項目）
- health-check: **日次の数値**スナップショット（各カテゴリの滞留件数）

## 制約

- read-only。persist しない（イベントを書かない）
- overdue / 期日が近い は現在時刻依存の read 時派生（[ADR-0028](../../adr/0028-task-scheduling-fields.md)）。集計は host 側で行い、MCP 側に新 tool / 派生フィールドを足さない
- 時間窓は下限 inclusive `*After` / 上限 exclusive `*Before`
- 本 skill は手順書のみで実処理を持たない
