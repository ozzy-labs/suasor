---
name: external-brief
description: 「上司向け週次報告」「クライアント向け進捗まとめ」「外向きステータス」「マネージャーに送る report」「お客さんに見せる進捗」と頼まれたら、Suasor MCP の task.list（state=completed, updated_after=対象期間開始）と decision.list（recorded_after=対象期間開始）を組み合わせて完了タスク + 意思決定を引き、brief で外向き tone のまとめを返す。persist なし。
readOnly: true
category: brief
triggers:
  - 上司向け週次報告
  - クライアント向け進捗まとめ
  - 外向きステータス
  - マネージャーに送る report
  - お客さんに見せる進捗
pairs:
  - personal-brief
mcp_tools_read:
  - task.list
  - decision.list
  - brief
mcp_tools_write: []
---

# external-brief

外向き（上司 / クライアント）の進捗レポートを組み立てる。read-only。pair: 自分向けは [personal-brief](../personal-brief/SKILL.md)。

## いつ発火するか

- 「上司向け週次報告」「クライアント向け進捗まとめ」「外向きステータス」
- 「マネージャーに送る report」「お客さんに見せる進捗」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. 対象期間の開始を ISO 8601 で決める（既定は直近 1 週間）
2. `task.list`（`state=completed`、`updatedAfter=対象期間開始`）で完了 task を引く
3. `decision.list`（`recordedAfter=対象期間開始`）で記録された意思決定を引く
4. `brief` で外向き tone のまとめを生成する（LLM 要約。委譲先で生成、[ADR-0006](../../adr/0006-ml-delegation.md)）。内部のみの未確定事項・生本文は外向きから落とす
5. 外向きレポート text を返す

## 制約

- read-only。persist しない（text-only）
- 外部 SaaS への送信はしない。ユーザーが受け取った text を手で送る
- 本 skill は手順書のみで実処理を持たない
