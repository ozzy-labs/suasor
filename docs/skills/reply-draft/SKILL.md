---
name: reply-draft
description: 「返信案を考えて」「下書き作って」「これに返信したい」と頼まれたら、Suasor MCP の propose.generate（reply_draft mode、reply_to_source_id 指定）で返信下書きを生成し、ユーザー確認後に propose.apply で承認分のみ保存する。外部 SaaS への送信はせず、ユーザーが下書きを確認して手で送る。HITL（auto-apply なし）。
---

# reply-draft

返信下書きを生成する HITL write skill。生成だけでは送信も保存もしない（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

## いつ発火するか

- 「返信案を考えて」「下書き作って」「これに返信したい」

## 何をするか（MCP tool flow）

write tool は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. 返信元 source を特定する（必要なら `source.get` / `search` で `externalId` を確定）
2. `propose.generate`（mode=`reply_draft`、`reply_to_source_id=<externalId>`）で返信下書き候補を生成する。これは `ReplyDraftProposed` event（HITL・未適用、[data-model.md](../../design/data-model.md)）に対応する候補で、まだ確定・送信されない
3. **生成した下書きをユーザーに提示して確認を取る**（native framing: ホスト側で人の承認を促す）
4. ユーザーが承認した候補のみ `propose.apply` で保存する（idempotent）

## 制約

- HITL。人の承認なしに `propose.apply` を呼ばない。auto-apply しない
- 外部 SaaS への送信は行わない。ユーザーが下書きを確認して手で送る
- 本 skill は手順書のみで実処理を持たない
