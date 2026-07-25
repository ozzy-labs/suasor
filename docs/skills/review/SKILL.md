---
name: review
description: 「この設計書レビューして」「この PR レビューして」「前回から何が変わった」「仕様の抜け漏れ確認」「#123 確認して」と頼まれたら、対象（document / pr / diff）を見分けて Suasor MCP の source.get / source.history / search / graph.related を読み取り系で組み合わせ、レビュー所見または変更点の要約を返す。read-only、外部投稿はしない。
readOnly: true
category: review
triggers:
  - この設計書レビューして
  - この PR レビューして
  - 前回から何が変わった
  - 仕様の抜け漏れ確認
  - この資料の差分
pairs:
  - find
mcp_tools_read:
  - source.get
  - source.history
  - search
  - graph.related
  - decision.list
mcp_tools_write: []
---

# review

レビューの単一入口（[ADR-0046](../../adr/0046-agent-surface-contraction.md)）。**target** で振る舞いを決める。read-only。

以前は `doc-review` / `doc-diff` / `pr-review` の 3 本に分かれていたが、ユーザーの「レビューして」からはどれが発火すべきか判別できなかった。違いは**何を見るか**だけである。

## いつ発火するか

| 言いかた | target |
| --- | --- |
| 「この設計書レビューして」「仕様のレビュー」「この提案どう思う」「抜け漏れ確認」 | `document` |
| 「この PR レビューして」「#123 確認して」「PR どう思う」 | `pr` |
| 「前回から何が変わった」「この資料の差分」「どこが更新された」 | `diff` |

対象が曖昧なら聞き返す（PR 番号があれば `pr`、source id / 資料名があれば `document`、「変わった」「差分」の語があれば `diff`）。

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。**外部への投稿は行わない**（PR コメント投稿は egress なので本 skill の範囲外。ユーザーが手で貼る）。

### target=document

1. `source.get`（`externalId`）で本文を読む。provenance も要るなら `include: ["links"]`
2. `search` で関連する先行仕様・過去の議論を引く
3. `graph.related` / `decision.list` で関連する決定を辿る
4. **整合性 / 抜け漏れ / 前提 / リスク**の観点で所見を組み立てる

### target=pr

1. `search` で関連 source / 過去の review / 関連決定を引く
2. 必要に応じて `gh pr diff` の出力（ホスト側で取得）と突き合わせる
3. レビュー観点を提示する。**PR への comment 投稿はしない**

### target=diff

1. `source.history`（`externalId`）で event log から本文の版を引く（[ADR-0002](../../adr/0002-event-sourced-architecture.md) — 全版が残る）
2. 直近 2 版、または期間指定の前後版を突き合わせる
3. 変更点を要約する（何が追加 / 削除 / 変更されたか）

## 制約

- read-only。persist しない・外部に投稿しない
- 判断（良し悪し）はホスト LLM 側。本 skill は手順書のみで実処理を持たない
- `source.history` は本文の版のみを再構成する。メタデータの変遷は対象外
