---
name: doc-diff
description: 「前回から何が変わった」「この資料の差分」「<doc> はどこが更新された」「仕様のどこが変わったか」と頼まれたら、Suasor MCP の source.history で対象 source の本文版を event log から引き、直近 2 版（または期間指定の前後版）を突き合わせて変更点を要約する。read-only、persist なし。
---

# doc-diff

取り込み済み source（設計書 / 仕様 / PDF / スプレッドシート等）の「**前回から何が変わったか**」を本文版の突き合わせで返す read-only skill。`SourceObserved` / `SourceBodyUpdated` event が全文 body を保持する（[ADR-0002](../../adr/0002-event-sourced-architecture.md)）ため、`source.history` で過去版を引いて真の before/after 差分を組める（projection は現本文のみ保持）。

## いつ発火するか

- 「前回から何が変わった」「この資料の差分」「どこが更新された」
- 「仕様のどこが変わったか」「`<doc>` の変更点」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. 対象 source を特定する。漠然としていれば `search` / `recall.search` / `source.list`（`observedAfter` で期間絞り）で当たりを付ける
2. `source.history`（`externalId`、`limit?`）で本文版を新しい順に引く。各版は `observedAt` / `fingerprint` / `body` / `recordedAt`
3. 直近 2 版（最新 = `versions[0]` と前版 = `versions[1]`）、または期間指定なら該当前後版を突き合わせ、**変更点を host LLM が要約**する（追加/削除/変更の要旨）。版が 1 つだけなら「更新履歴なし（初版のみ）」と返す
4. 必要なら `graph.related` で関連 decision / task を添える

## 制約

- read-only。persist しない。差分は本文版の比較で、外部 diff ツールは使わない
- `source.history` は event log（`SourceObserved` / `SourceBodyUpdated`）由来で**全文版**を返す。projection（`source.get`）は現本文のみなので差分には使えない
- [ADR-0023](../../adr/0023-local-filesystem-connectors.md) 系で本文未抽出（name-only）の Office/PDF は、本文抽出（epic #124 / #120）が入るまで「名前のみ」の差分になる
- 本 skill は手順書のみで実処理を持たない
