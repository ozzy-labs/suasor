---
name: reply-draft
description: 「返信案を考えて」「下書き作って」「これに返信したい」と頼まれたら、Suasor MCP の propose.generate（reply_draft mode、reply_to_source_id 指定）で返信下書きを生成し、ユーザー確認後に propose.apply で承認分のみ保存する。外部 SaaS への送信はせず、ユーザーが下書きを確認して手で送る。HITL（auto-apply なし）。
readOnly: false
category: draft
triggers:
  - 返信案を考えて
  - 下書き作って
  - これに返信したい
pairs: []
mcp_tools_read:
  - source.get
mcp_tools_write:
  - propose.generate
  - propose.apply
  - draft.export
---

# reply-draft

返信下書きを生成する HITL write skill。生成だけでは送信も保存もしない（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

## いつ発火するか

- 「返信案を考えて」「下書き作って」「これに返信したい」

## 何をするか（MCP tool flow）

write tool は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. 返信元 source を特定する（必要なら `source.get` / `search` で `externalId` を確定）
2. `propose.generate`（mode=`reply_draft`、`reply_to_source_id=<externalId>`）で返信下書き候補を生成する。これは `ReplyDraftProposed` event（HITL・未適用、[data-model.md](../../design/data-model.md)）に対応する候補で、まだ確定・送信されない
3. `propose.list`（`state=pending`）で生成済みの下書き候補を一覧し、**ユーザーに提示して確認を取る**（native framing: ホスト側で人の承認を促す。[Issue #89](https://github.com/ozzy-labs/suasor/issues/89)）
4. ユーザーが承認した候補のみ `propose.apply` で保存する（idempotent）。**不要な下書きは `propose.reject`（任意で理由）で却下する**（却下は記録され、再 apply されない）

## 制約

- HITL。人の承認なしに `propose.apply` を呼ばない。auto-apply しない。`propose.list` は read（候補確認）、`propose.reject` は却下の記録
- 外部 SaaS への送信は行わない。ユーザーが下書きを確認して手で送る
- 下書きをファイルで欲しい場合は `draft.export`（HITL write）で `.md` / `.txt` にローカル書き出しできる（送信はしない・[ADR-0025](../../adr/0025-local-draft-export.md)）
- 本 skill は手順書のみで実処理を持たない
