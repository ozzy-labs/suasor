---
name: meeting-followup
description: 「会議後の action items」「ミーティングのフォローアップ」「議事録から task 抽出」「打ち合わせのフォロー」と頼まれたら、Suasor MCP の source.list（calendar source）で直近の会議を集め、source.get で議事録を読み recall.search で関連やりとりを引いた上で、propose.generate（mode=meeting_followup）で task / decision 候補を生成し、ユーザー確認後に propose.apply で承認分のみ保存する。auto-apply 経路は存在しない。
---

# meeting-followup

会議後に action items を抽出する HITL write skill（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。pair: 会議前は [meeting-prep](../meeting-prep/SKILL.md)。

## いつ発火するか

- 「会議後の action items」「ミーティングのフォローアップ」「議事録から task 抽出」
- 「昨日の会議どうだった」「打ち合わせのフォロー」

## 何をするか（MCP tool flow）

read で集め、write は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `source.list`（calendar の `sourceType`、`observedBefore=now` で直近）で対象会議を集める
2. `source.get`（`externalId`）で議事録 / 関連やりとりを読む
3. `recall.search` で会議トピックの関連 context を引く（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
4. `propose.generate`（mode=`meeting_followup`）で task / decision 候補を生成する（`TaskProposed` / `DecisionRecorded` 候補に対応、[data-model.md](../../design/data-model.md)）
5. `propose.list`（`state=pending`）で生成済み候補を一覧し、**ユーザーに提示して確認を取る**（native framing: ホスト側で人の承認を促す。[Issue #89](https://github.com/ozzy-labs/suasor/issues/89)）
6. ユーザーが承認した候補のみ `propose.apply` で保存する（idempotent）。**不要な候補は `propose.reject`（任意で理由）で却下する**（却下は記録され、再 apply されない）

## 制約

- HITL。人の承認なしに `propose.apply` を呼ばない。auto-apply しない。`propose.list` は read（候補確認）、`propose.reject` は却下の記録
- 本 skill は手順書のみで実処理を持たない
