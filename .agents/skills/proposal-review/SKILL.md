---
name: proposal-review
description: 「保留中の提案を確認」「pending な候補をレビュー」「溜まってる draft を捌いて」「提案を承認/却下」と頼まれたら、Suasor MCP の propose.list（state=pending）で生成済み候補を一覧し、ユーザーに提示して確認を取った上で、承認分のみ propose.apply で適用し、不要分は propose.reject（任意で理由）で却下する。auto-apply 経路は存在しない。
---

# proposal-review

各 skill（reply-draft / source-extract / meeting-followup / inbox-triage / commitment-review）が貯めた `pending` 候補をまとめてレビューし、承認/却下する HITL write skill。`propose.*` ライフサイクル（[Issue #89](https://github.com/ozzy-labs/suasor/issues/89)）の「出口」= 承認キューに当たる（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

## いつ発火するか

- 「保留中の提案を確認」「pending な候補をレビュー」
- 「溜まってる draft を捌いて」「提案を承認/却下」「承認待ちある?」

## 何をするか（MCP tool flow）

read で集めて、write は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `propose.list`（`state=pending`）で承認待ち候補を一覧する。`kind`（`task` / `decision` / `reply_draft` / `triage` / `commitment`）や `updated_at` 時間窓で絞り込める。各行は `candidateId` / `mode` / `kind` / `summary` / `createdAt`
2. 候補を kind / mode 別に整理し、**ユーザーに提示して 1 件ずつ（または一括で）承認 / 却下の判断を取る**（native framing: ホスト側で人の承認を促す）
3. 承認分は `propose.apply` でまとめて適用する（対応する domain event を append、idempotent。既適用は `skipped`）。適用で ledger が `pending` → `applied` に遷移する
4. 却下分は `propose.reject`（`candidateId`、任意で `reason`）で却下する。ledger が `pending` → `rejected` に遷移し、以後 `propose.list` の `pending` に現れない（再提示しない）

## 制約

- HITL。人の承認なしに `propose.apply` / `propose.reject` を呼ばない。auto-apply しない。`propose.list` は read（候補確認）
- 候補は生成元 skill が `propose.generate` で作る。本 skill は候補を**生成しない**（横断レビューに専念）。新規候補が要るなら生成元 skill（reply-draft 等）を使う
- 状態依存: `propose.reject` は `pending` のときのみ却下。`applied`（適用済み）/ `missing`（該当なし）は遷移させず status で報告し、`rejected` 再呼び出しは `already_rejected`（no-op）
- 本 skill は手順書のみで実処理を持たない
