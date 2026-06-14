---
name: find-document
description: 「あの資料どこ」「先週共有された PDF」「<キーワード>含むファイル」「あの議事録」「あの Doc」と頼まれたら、Suasor MCP の search（FTS5 全文検索）で本文ベースに横断検索し、connector 取り込み済みの source を返す。意味検索が要るときは recall.search を補助的に併用する。外部 SaaS を直接叩かない。
---

# find-document

取り込み済み source を本文ベースで横断検索して「あの資料」を見つける。FTS-first（[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）。

## いつ発火するか

- 「あの資料どこ」「先週共有された PDF」「<キーワード>含むファイル」「あの議事録」「あの Doc」「あのメール」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。外部 SaaS は直接叩かず、local projection の保持本文（[ADR-0003](../../adr/0003-local-first-and-content-minimization.md)）だけを検索する。

1. `search`（FTS5、[retrieval.md](../../design/retrieval.md)）で query を本文全文検索する。返り値 `hits[]` は `externalId` / `sourceType` / `observedAt` / `score`（bm25 昇順=より関連）/ `body`、および `strategy`（`fts` | `like-fallback`）
2. 必要なら `source.list`（`sourceType` 絞り / `observedAfter` / `observedBefore`）で source 種別・期間を絞り込む
3. 本文全体が要れば `source.get`（`externalId`）で取得する
4. 意味検索ハイブリッドが要る場合のみ `recall.search` を補助的に併用する（embedding 無効時は `signal: embedding_disabled` を見て `search` に寄せる）
5. 該当 source を提示して返す

## 制約

- read-only。本文取得は read 経路のみ。外部 SaaS API を直接呼ばない
- 短クエリは `search` が `like-fallback` に切り替わる（[retrieval.md](../../design/retrieval.md)）
- 本 skill は手順書のみで実処理を持たない
