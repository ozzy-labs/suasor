---
name: inbox-triage
description: 「受信箱整理して」「inbox 仕分けて」「未処理アイテム捌いて」「pending を片付けて」と頼まれたら、Suasor MCP の inbox.list（state=open）で未処理アイテムを集め、propose.generate（mode=inbox_triage）で各アイテムへの action 候補（task 化 / decision 記録）を生成し、ユーザー確認後に propose.apply で承認分のみ保存する。auto-apply 経路は存在しない。
---

# inbox-triage

未処理 inbox を仕分ける HITL write skill。各アイテムを task 化 / decision 記録 / dismiss する action 候補を提案し、承認分のみ適用する（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

## いつ発火するか

- 「受信箱整理して」「inbox 仕分けて」「未処理アイテム捌いて」「pending を片付けて」

## 何をするか（MCP tool flow）

read で集めて、write は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `inbox.list`（`state=open`）で未処理アイテムを集める。各 item は `source_external_id` / `state` / `updated_at`
2. `propose.generate`（mode=`inbox_triage`）で各アイテムへの action 候補を生成する。候補は次のいずれか:
   - **task 化** — `task.create`（write tool）に渡す task 候補。`TaskProposed` event に対応
   - **decision 記録** — `DecisionRecorded` に対応する候補
   - **仕分け** — `InboxItemTriaged`（state: snoozed / done / dismissed）に対応する候補
3. **生成した action 候補一式をユーザーに提示して確認を取る**（native framing: ホスト側で人の承認を促す）
4. ユーザーが承認した候補のみ `propose.apply` で保存する（idempotent）。task 化を含む場合も承認後に適用する

## 制約

- HITL。人の承認なしに `propose.apply` / `task.create` を呼ばない。auto-apply しない
- `inbox.state` の語彙: `open` / `snoozed` / `done` / `dismissed`（[data-model.md](../../design/data-model.md)）
- 本 skill は手順書のみで実処理を持たない
