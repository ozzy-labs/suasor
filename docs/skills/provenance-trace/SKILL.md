---
name: provenance-trace
description: 「この task の出どころ」「由来を辿って」「<entity> は何から来た」「この decision の根拠 source」「provenance を遡って」と頼まれたら、Suasor MCP の graph.related（1-hop 隣接）/ graph.expand（depth 付き BFS、direction=in で後方トレース）で links projection 上の provenance を辿り、source.get で本文を補って由来チェーンを組み立てて返す。read-only、persist なし。
readOnly: true
category: graph
triggers:
  - この task の出どころ
  - 由来を辿って
  - "<entity> は何から来た"
  - この decision の根拠 source
  - provenance を遡って
pairs: []
mcp_tools_read:
  - graph.related
  - graph.expand
  - source.get
mcp_tools_write: []
---

# provenance-trace

任意の entity（task / decision / source 等）を起点に「何に由来するか」を `links` projection 上で辿る read-only skill（[ADR-0018](../../adr/0018-knowledge-graph-traversal.md) / [ADR-0020](../../adr/0020-multi-actor-coordination-scope.md)）。`decision-rationale`（決定の「なぜ」）や `research`（トピック横断）に埋もれていた汎用 provenance トレースを正面から扱う。

## いつ発火するか

- 「この task の出どころ」「由来を辿って」「`<entity>` は何から来た」
- 「この decision の根拠 source」「provenance を遡って」「どこから派生した?」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。本文は持たず、`links` projection の有向エッジを辿る。

1. 起点 entity を `kind` + `id` で特定する（例 `task` / `decision` / `source`）
2. provenance を辿る:
   - `graph.related`（1-hop 隣接）で直近の由来 / 関連を引く。`direction`（`out` / `in` / `both`、既定 `both`）/ `relation` で絞る
   - 多段で遡るなら `graph.expand`（`depth` 既定 2・max 10 / `limit`）で BFS 展開する
   - **後方トレース**（「この成果物は何に由来するか」）は `direction=in` で incoming のみを遡る（[ADR-0020](../../adr/0020-multi-actor-coordination-scope.md)）。下流の consumer を見るなら `direction=out`
3. relation は自動エッジ `derived_from` / `replies_to` / `references` と手動エッジ `manual_link`（手動 link は `linkId` 付き）
4. 辿り着いた node の本文が要るものは `source.get`（`externalId`）で補う
5. 由来チェーン（origin → 由来 source / 先行 entity）を組み立てて返す

## 制約

- read-only。persist しない。エッジの追加 / 削除（`link.add` / `link.remove`）は本 skill では行わない（別経路の HITL write）
- `graph.expand` の `depth` は max 10。cycle guard と edge dedup は traversal 側で担保される
- 本 skill は手順書のみで実処理を持たない
