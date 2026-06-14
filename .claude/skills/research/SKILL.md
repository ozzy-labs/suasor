---
name: research
description: 「<X> について調べて」「<Y> の経緯」「<Z> に関するすべての情報」「<トピック> を網羅的に教えて」と頼まれたら、Suasor MCP の recall.search（意味検索）+ search（FTS5 全文）+ graph.related（関連 entity 拡張）+ brief（統合要約）を順に叩き、sources 一覧 / 関連 entities / 経緯サマリを組み立てて返す。read-only、persist なし。
---

# research

トピックを横断調査して「関連するすべて」を組み立てる。FTS-first（[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）に意味検索とグラフ拡張を重ねる。

## いつ発火するか

- 「`<X>` について調べて」「`<Y>` の経緯」「`<Z>` に関するすべての情報」
- 「`<トピック>` を網羅的に教えて」「`<キーワード>` 周りの状況」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `recall.search` で意味的に関連する source を引く（embedding 無効時は `signal: embedding_disabled` を見て次の `search` に寄せる）
2. `search`（FTS5）で本文全文検索を重ね、語の一致を取りこぼさないようにする
3. `graph.related` でヒットした entity（source / decision / task）を起点に関連 entity を辿る
4. `brief` で集めた context を統合要約する（LLM 要約。委譲先で生成、[ADR-0006](../../adr/0006-ml-delegation.md)）
5. sources 一覧 / 関連 entities / 経緯サマリを組み立てて返す

## 制約

- read-only。persist しない
- 本 skill は手順書のみで実処理を持たない
