---
name: decision-rationale
description: 「あの決定はなぜ」「X を選んだ理由」「Y の決定経緯」「なんで A じゃなくて B にしたんだっけ」「この方針の根拠は?」と聞かれたら、Suasor MCP の decision.list（期間 / トピック絞り）+ graph.related（decision から関連 source / 先行 decision へ provenance を辿る）+ recall.search（関連 context の補強）を組み合わせ、決定 + 経緯 + 関連 source + 関連 prior decisions のサマリを返す。read-only。
readOnly: true
category: decision
triggers:
  - あの決定はなぜ
  - X を選んだ理由
  - Y の決定経緯
  - なんで A じゃなくて B にしたんだっけ
  - この方針の根拠は?
pairs: []
mcp_tools_read:
  - decision.list
  - graph.related
  - recall.search
mcp_tools_write: []
---

# decision-rationale

過去の決定の「なぜ」を provenance を辿って組み立てる。read-only。

## いつ発火するか

- 「あの決定はなぜ」「X を選んだ理由」「Y の決定経緯」
- 「なんで A じゃなくて B にしたんだっけ」「この方針の根拠は?」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。`decisions` projection は `rationale` + provenance（`links`）を保持する（[data-model.md](../../design/data-model.md)）。

1. `decision.list`（`recordedAfter` / `recordedBefore` で期間絞り）で対象決定を引く。各 decision は `title` / `rationale` / `recorded_at`
2. `graph.related` で当該 decision を起点に、関連 source（根拠になったやりとり）/ 先行 decision（先立つ判断）へ `links` を辿る
3. `recall.search` で関連 context を補強する（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
4. 決定 + 経緯（rationale）+ 関連 source + 関連 prior decisions のサマリを組み立てて返す

## 制約

- read-only。persist しない
- 本 skill は手順書のみで実処理を持たない
