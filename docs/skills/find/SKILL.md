---
name: find
description: 「あの資料どこ」「先週共有された PDF」「<X> について調べて」「<Y> の経緯」「網羅的に教えて」や、対象を明示しない「あれどうなった」の類の進捗・経緯質問を受けたら、Suasor MCP の search（mode=auto）で横断検索し、深掘りが要るときは graph.related / brief で関連 entity と経緯まで辿る。read-only、外部 SaaS は直接叩かない。
readOnly: true
category: retrieval
triggers:
  - あの資料どこ
  - 先週共有された PDF
  - この件について調べて
  - あの件の経緯
  - 網羅的に教えて
  - あれどうなった
pairs:
  - source-review
  - decisions
mcp_tools_read:
  - search
  - source.get
  - source.list
  - graph.related
  - brief
mcp_tools_write: []
---

# find

検索・調査の単一入口（[ADR-0046](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0046-agent-surface-contraction.md)）。**depth** で「1 件を見つける」と「網羅的に調べる」を切り替える。read-only。

以前は `find-document`（探す）と `research`（調べる）に分かれていたが、境目はユーザーの言い方ではなく**どこまで辿るか**だった。

## いつ発火するか

| 言いかた | depth |
| --- | --- |
| 「あの資料どこ」「先週共有された PDF」「<キーワード> 含むファイル」「あの議事録」 | `locate`（既定） |
| 「`<X>` について調べて」「`<Y>` の経緯」「網羅的に教えて」「全部教えて」「あれどうなった」（対象を明示しない進捗・経緯質問） | `research` |

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0004-mcp-agent-boundary-and-hitl.md)）。

対象を明示しない「あれどうなった」は本 skill が受け、会話文脈から対象を推定して `search` + `graph.related` で現状・経緯を組み立てる（推定できなければ聞き返す）。**約束を明示した**「相手に頼んだ約束どうなった」だけが [commitment-chase](../commitment-chase/SKILL.md) の領分。

### depth=locate（既定）

1. `search`（`mode` は既定の `auto` — embedding があれば hybrid、無ければ FTS。**アルゴリズムを自分で選ばない**、[ADR-0046](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0046-agent-surface-contraction.md) 決定 2）。`sourceType` / `observedAfter` / `observedBefore` で絞る
2. hit が多すぎる / 少なすぎるときだけ `mode` を明示する（完全一致で絞るなら `fts`、語彙が違うと踏んでいるなら `semantic`）
3. 候補を「どこで・いつ・誰が」で識別できる形で提示する。本文全文が要るときだけ `source.get`

### depth=research

1. `search` で入口を取る（同上）
2. `graph.related` で関連 entity（decision / task / 先行 source）へ 1 hop 広げる
3. 必要なら `brief`（対象期間）で周辺の動きを補う
4. **sources 一覧 / 関連 entities / 経緯サマリ**を組み立てて返す

## 制約

- read-only。persist しない
- **外部 SaaS を直接叩かない** — 取り込み済み source のみが対象（未取り込みなら `<connector> sync` を案内する）
- `search` の応答が `signal: embedding_disabled` を含むときは意味検索が効いていない。語彙違いの取りこぼしがありうる旨を添える（[ADR-0005](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0005-fts-first-retrieval-embedding-sidecar.md)）
- 結果が `truncated: true` なら全件ではない。窓を狭めるかページングする（[ADR-0007](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0007-connector-contract.md)）
