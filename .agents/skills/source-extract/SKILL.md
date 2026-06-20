---
name: source-extract
description: 「この資料から task 抽出」「これに含まれる decisions 教えて」「<source_id> から候補を」「このドキュメントから ToDo 拾って」と頼まれたら、Suasor MCP の source.get で対象 source の本文を読み、propose.generate（mode=source_extract）で task / decision / reply_draft 候補を生成し、ユーザー確認後に propose.apply で承認分のみ保存する。auto-apply 経路は存在しない。
---

# source-extract

特定 source の本文から task / decision / reply_draft 候補を抽出する HITL write skill（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

## いつ発火するか

- 「この資料から task 抽出」「これに含まれる decisions 教えて」
- 「`<source_id>` から候補を」「このドキュメントから ToDo 拾って」

## 何をするか（MCP tool flow）

read で本文を取り、write は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. 対象 source を特定する（`externalId` 不明なら `search` / `find-document` で確定）
2. `source.get`（`externalId`）で対象 source の本文を読む
3. `propose.generate`（mode=`source_extract`）で task / decision / reply_draft 候補を生成する（それぞれ `TaskProposed` / `DecisionRecorded` / `ReplyDraftProposed` 候補に対応、[data-model.md](../../design/data-model.md)）
4. `propose.list`（`state=pending`）で生成済み候補を一覧し、**ユーザーに提示して確認を取る**（native framing: ホスト側で人の承認を促す。[Issue #89](https://github.com/ozzy-labs/suasor/issues/89)）
5. ユーザーが承認した候補のみ `propose.apply` で保存する（idempotent）。**不要な候補は `propose.reject`（任意で理由）で却下する**（却下は記録され、再 apply されない）

## 制約

- HITL。人の承認なしに `propose.apply` を呼ばない。auto-apply しない。`propose.list` は read（候補確認）、`propose.reject` は却下の記録
- 本 skill は手順書のみで実処理を持たない
