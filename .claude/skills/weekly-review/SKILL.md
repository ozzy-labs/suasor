---
name: weekly-review
description: 「週次レビュー」「棚卸し」「今週の振り返りと残課題」「今週やり残したこと」「週次の整理」と頼まれたら、Suasor MCP の task.list（state∈{open,in_progress} + overdue 抽出）+ commitment.list（双方向）+ inbox.list（state=open 滞留）+ brief（since=7d）を読み取り系で合成し、未完 task / 約束 / 滞留 inbox の棚卸しサマリと落ちている項目を提示する。状態遷移は task-update / inbox-triage / commitment-review skill へ HITL 橋渡しする。read-only / persist なし。
---

# weekly-review

open task / commitment / 滞留 inbox を週次で棚卸しする read skill。「今週何が動いて、何が落ちているか」を read-only で組み立て、対応が要るものは write skill へ HITL 橋渡しする（[ADR-0008](../../adr/0008-assistant-skills.md) の skill 設計）。**新 MCP tool は不要**で、既存 read tool の合成で実現する。

## いつ発火するか

- 「週次レビュー」「週次の整理」「棚卸し」
- 「今週の振り返りと残課題」「今週やり残したこと」

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。副作用なし・エージェント自律 OK。**専用 tool は追加しない**（既存合成、[ADR-0008](../../adr/0008-assistant-skills.md)）。

1. 棚卸し期間を決める。明示がなければ直近 7 日。ISO 8601（offset 付き）の `since`（= 7 日前）を作る
2. `task.list`（`state=open` / `state=in_progress`）で未完 task を引く。`overdue=true` で期限超過 task を別枠で surface する（read 時派生、[ADR-0028](../../adr/0028-task-scheduling-fields.md)）。`dueBefore` で来週分の期日が近い task も拾える
3. `commitment.list`（`state=open`）を **双方向**で引く。`direction=owed_by_me`（自分が果たすべき約束）と `direction=owed_to_me`（相手に催促すべき約束）を分けて整理する（[ADR-0021](../../adr/0021-commitment-ledger.md)）
4. `inbox.list`（`state=open`）で未処理のまま滞留している inbox 項目を集める。`since` より古い `updated_at` のものを「滞留」として強調する
5. `brief`（`since`=7 日前）で今週の主要な動きの LLM 要約を取る（委譲先で生成、[ADR-0006](../../adr/0006-ml-delegation.md)）
6. ホスト LLM が「今週動いたこと」「残っている未完 task（overdue 優先）」「双方向の約束」「滞留 inbox」を棚卸しサマリとして組み立て、落ちている項目を提示する

## 橋渡し（write は HITL）

棚卸しで見つかった「対応すべき項目」は、本 skill では書かず、対応する write skill へ HITL で橋渡しする（auto-apply なし、[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）:

- task の状態遷移（完了 / 進行中 / 見送り）→ [task-update](../task-update/SKILL.md)
- 滞留 inbox の仕分け → [inbox-triage](../inbox-triage/SKILL.md)
- 約束の解決 / 催促 → [commitment-review](../commitment-review/SKILL.md) / [commitment-chase](../commitment-chase/SKILL.md)

## 制約

- read-only。persist しない（イベントを書かない）。状態遷移は上記 write skill へ HITL 橋渡しし、本 skill 内で write tool を呼ばない
- overdue は現在時刻依存の read 時派生（[ADR-0028](../../adr/0028-task-scheduling-fields.md)）。時間窓は下限 inclusive `*After` / 上限 exclusive `*Before`
- 本 skill は手順書のみで実処理を持たない
