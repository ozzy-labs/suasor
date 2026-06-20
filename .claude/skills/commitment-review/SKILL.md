---
name: commitment-review
description: 「約束をスキャンして」「誰に何を約束したっけ」「貸し借り確認」「期限が来てる commitment」「この約束は完了」「コミットメント台帳」と頼まれたら、Suasor MCP の propose.generate（mode=commitment_scan）で source から約束候補を抽出し、ユーザー確認後に propose.apply で台帳に open 登録する。既存台帳は commitment.list（state / direction フィルタ）で確認し、commitment.resolve / .dismiss / .reopen で状態遷移する。auto-apply 経路は存在しない。
---

# commitment-review

取り込み済み source から抽出した「約束/コミットメント」（"X までに Y する" の類）を台帳で HITL 管理する write skill。抽出は propose パイプラインに寄せ（[ADR-0006](../../adr/0006-ml-delegation.md) の ML 委譲境界を 1 本に保つ）、台帳の状態遷移（open / resolved / dismissed）を専用 write tool で行う（[ADR-0021](../../adr/0021-commitment-ledger.md) / [ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。pair: 相手が負う約束（`owed_to_me`）の期限超過を能動的に催促する [commitment-chase](../commitment-chase/SKILL.md)（read-only）。

## いつ発火するか

- 「約束をスキャンして」「最近の約束を拾って」（抽出）
- 「誰に何を約束したっけ」「貸し借り確認」「コミットメント台帳」（確認）
- 「期限が来てる commitment」「この約束は完了」「これは誤検出」（解決）

## 何をするか（MCP tool flow）

read で集めて、write は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

### A. 抽出（scan）

1. `propose.generate`（mode=`commitment_scan`）で source から `commitment` 候補を生成する。各候補は `title` / `direction`（`owed_by_me` / `owed_to_me`）/ `dueDate?` / `person?` / `sourceExternalIds[]`。重い推論はホスト側で行う（[ADR-0006](../../adr/0006-ml-delegation.md)）
2. `propose.list`（`state=pending`）で生成済み候補を一覧し、**ユーザーに提示して確認を取る**（`commitment` 候補は `propose.list` の `kind` フィルタ対象外なので、`mode` / `summary` で見分ける）
3. ユーザーが承認した候補のみ `propose.apply` で適用する（`CommitmentOpened` を append → 台帳に `open` 登録、idempotent）。**不要な候補は `propose.reject`（任意で理由）で却下する**

### B. 確認（list）

1. `commitment.list` で台帳を引く。`state`（`open` / `resolved` / `dismissed`）と `direction`（`owed_by_me` / `owed_to_me`）でフィルタ、`updated_at` の時間窓も可
2. open な約束を direction 別（自分が負う / 相手が負う）に整理して提示する。`brief` / `next-actions` skill が demand と並べる「やるべきこと」signal と同じ台帳

### C. 解決（state 遷移）

ユーザーの指示に従い、対象 commitment の状態を遷移させる（いずれも HITL・idempotent）:

- `commitment.resolve` — `open` → `resolved`（果たした）
- `commitment.dismiss` — `open` → `dismissed`（誤検出 / 不要）
- `commitment.reopen` — `resolved` / `dismissed` → `open`（やり直し）

## 制約

- HITL。人の承認なしに `propose.apply` / `commitment.resolve` / `.dismiss` / `.reopen` を呼ばない。auto-apply しない。`commitment.list` / `propose.list` は read（確認）、`propose.reject` は却下の記録
- commitment id は content 由来（`title` + `direction` + provenance）。同一約束の再抽出は台帳上 no-op で、`resolved` / `dismissed` を勝手に `open` へ蘇生させない（`dueDate` / `person` は id に含めない）
- 状態機械: `resolve` は `dismissed` からは不可（先に `reopen`）、`dismiss` は `resolved` からは不可。不正遷移は status で報告される
- 本 skill は手順書のみで実処理を持たない
