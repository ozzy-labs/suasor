---
name: source-forget
description: 「あの誤って取り込んだ資料を消して」「この source を忘れて」「機密だから purge して」「取り込んだ <X> をローカルから削除して」「忘れられる権利で消して」と頼まれたら、Suasor MCP の search / source.list で対象 source を特定し、不可逆である旨をユーザーに確認した上で source.forget で本文を projection と event ログの双方から purge する。auto-apply 経路は存在しない。
readOnly: false
category: retrieval
triggers:
  - あの誤って取り込んだ資料を消して
  - この source を忘れて
  - 機密だから purge して
  - 取り込んだ資料をローカルから削除して
  - 忘れられる権利で消して
pairs: []
mcp_tools_read:
  - search
  - source.list
mcp_tools_write:
  - source.forget
---

# source-forget

取り込んだ特定 source をローカルから**真に消す** HITL write skill（[ADR-0026](../../adr/0026-source-forgetting.md) / [ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。content-minimization / local-first（[ADR-0003](../../adr/0003-local-first-and-content-minimization.md)）の必須機能で、誤取り込み・機密・「忘れられる権利」に対応する。本文を projection（`sources` / `sources_fts`）からも event ログからも消し、監査 event（`SourceForgotten`）だけを残す。

## いつ発火するか

- 「あの誤って取り込んだ資料を消して」「取り込んだ `<X>` をローカルから削除して」
- 「この source を忘れて」「忘れられる権利で消して」
- 「機密だから purge して」

## 何をするか（MCP tool flow）

read で対象を特定して、purge は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。**不可逆**な破壊操作のため、実行前に必ず対象を提示して確認を取る。

1. 対象 source を特定する（`externalId` 不明なら `search`（FTS）/ `source.list` / `find-document` で確定）
2. 消す対象（`externalId` / タイトル / 由来）と、**不可逆・本文は復元できない**旨を**ユーザーに明示して確認を取る**（native framing: ホスト側で人の承認を促す）。任意で `reason` を添える
3. 承認後、`source.forget`（`externalId`, `reason?`）を呼ぶ。1 トランザクションで次を行う:
   - 当該 source の `SourceObserved` / `SourceBodyUpdated` の `body` を event redaction（append-only の明示的例外・[ADR-0026](../../adr/0026-source-forgetting.md)）
   - `SourceForgotten` を append（監査・本文を含まない）。その reducer が `sources` / `sources_fts` 行を DELETE
   - sidecar（`vec0` / `embeddings_meta` / `extraction_meta`）を imperative に DELETE

## 制約

- HITL。人の承認なしに `source.forget` を呼ばない。auto-apply しない。`search` / `source.list` は read（特定）
- **不可逆**。本文は projection・event ログの双方から消える（真の forget）。`projections rebuild` 後も purged 状態を再現（replay-stable）
- **links は残る**: 派生 link（task→source 等）は「今は無い source 由来」という provenance として残す（`source.get` は null、dangling 表示は許容）
- idempotent: 既 forget の再 forget は no-op。未知 id は `missing`（status で報告、throw しない）
- 本 skill は手順書のみで実処理を持たない
