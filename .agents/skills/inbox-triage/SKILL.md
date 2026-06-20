---
name: inbox-triage
description: 「受信箱整理して」「inbox 仕分けて」「未処理アイテム捌いて」「pending を片付けて」と頼まれたら、Suasor MCP の inbox.list（state=open）で未処理アイテムを集め、propose.generate（mode=inbox_triage）で各アイテムへの action 候補（task 化 / decision 記録）を生成し、ユーザー確認後に propose.apply で承認分のみ保存する。auto-apply 経路は存在しない。
readOnly: false
category: triage
triggers:
  - 受信箱整理して
  - inbox 仕分けて
  - 未処理アイテム捌いて
  - pending を片付けて
pairs: []
mcp_tools_read:
  - inbox.list
mcp_tools_write:
  - propose.generate
  - propose.apply
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
3. `propose.list`（`state=pending`）で生成済み候補を一覧し、**ユーザーに提示して確認を取る**（native framing: ホスト側で人の承認を促す。[Issue #89](https://github.com/ozzy-labs/suasor/issues/89)）
4. ユーザーが承認した候補のみ `propose.apply` で保存する（idempotent）。task 化を含む場合も承認後に適用する。**不要な候補は `propose.reject`（任意で理由）で却下する**（却下は記録され、再 apply されない）

### 直接書込ループ（`inbox.add` / `inbox.triage`・[Issue #88](https://github.com/ozzy-labs/suasor/issues/88)）

`propose.*` 経由のモデル提案に対し、人自身の捕捉・解決は直接 write tool でも行える（いずれも HITL）:

- `inbox.add`（`sourceExternalId`）— source を `open` で捕捉する
- `inbox.triage`（`inboxId` / `action` = `task` / `decision` / `discard`）— `open` 項目を解決する。`task` / `decision` は source 由来の task/decision を生成し項目を `done` に、`discard` は `dismissed` に遷移する。生成 entity は `task.create` / `decision.record` と同一の content 由来 id に着地する。`open` 以外の項目を triage しようとすると拒否される（state machine）

## 制約

- HITL。人の承認なしに `propose.apply` / `task.create` / `inbox.add` / `inbox.triage` を呼ばない。auto-apply しない。`propose.list` は read（候補確認）、`propose.reject` は却下の記録
- `inbox.state` の語彙: `open` / `snoozed` / `done` / `dismissed`（[data-model.md](../../design/data-model.md)）。`inbox.triage` は `open` → `done`（task/decision）/ `dismissed`（discard）の遷移のみ
- 本 skill は手順書のみで実処理を持たない
