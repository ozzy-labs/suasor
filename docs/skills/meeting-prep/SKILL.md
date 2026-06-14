---
name: meeting-prep
description: 「来週の会議準備」「明日のミーティング前確認」「次の会議の context」「<会議名> の準備して」「打ち合わせ前に状況教えて」と頼まれたら、Suasor MCP の source.list（calendar source）で該当 event を引き、recall.search で過去の関連やりとり、graph.related で関連 decisions / sources を辿り、会議準備サマリ（目的 / 過去文脈 / 関連 decisions / 参考 sources）を組み立てる。read-only、persist なし。
---

# meeting-prep

次の会議に向けた context を組み立てる。read-only。pair: 会議後は [meeting-followup](../meeting-followup/SKILL.md)。

## いつ発火するか

- 「来週の会議準備」「明日のミーティング前確認」「次の会議の context」
- 「<会議名> の準備して」「打ち合わせ前に状況教えて」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `source.list`（calendar の `sourceType`、`observedAfter` / `observedBefore` で対象期間）で該当 calendar event を引く
2. `source.get`（`externalId`）で event 本文・議題を取る
3. `recall.search` で過去の関連やりとりを引く（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
4. `graph.related` で関連 decisions / sources を辿る
5. 会議準備サマリ（目的 / 過去文脈 / 関連 decisions / 参考 sources）を組み立てて返す

## 制約

- read-only。persist しない
- 本 skill は手順書のみで実処理を持たない
