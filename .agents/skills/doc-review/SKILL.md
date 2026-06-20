---
name: doc-review
description: 「この設計書レビューして」「仕様のレビュー」「この PDF/資料を見て」「ドキュメントの抜け漏れ確認」「この提案どう思う」と頼まれたら、Suasor MCP の source.get で対象ドキュメント本文を読み、recall.search / graph.related で関連 decision・先行仕様を引いて、整合性・抜け漏れ・前提・リスクの観点でレビュー所見を返す。read-only、外部投稿しない。
---

# doc-review

仕様書・設計書・PDF・スライド等のドキュメントを、関連 decision・先行仕様を踏まえてレビューする read-only skill。コードを扱う `pr-review` のドキュメント版。Office/PDF は本文抽出（[ADR-0024](../../adr/0024-document-extraction-sidecar.md)・`[extraction]` 有効時）が入っていれば中身をレビューできる。

## いつ発火するか

- 「この設計書レビューして」「仕様のレビュー」「この提案どう思う」
- 「この PDF/資料を見て」「ドキュメントの抜け漏れ確認」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. 対象ドキュメントを特定する。漠然としていれば `search` / `recall.search`（意味検索。embedding 無効時は `signal: embedding_disabled` を見て `search` FTS へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）/ `find-document` で当たりを付ける
2. `source.get`（`externalId`）で本文を読む。Office/PDF は `[extraction]` 有効時に抽出テキストが本文に入る（無効なら name-only でレビュー不可 → 抽出の有効化を促す、[guide](../../guide/extraction.md)）
3. `recall.search` / `decision.list` / `graph.related` で**関連 decision・先行仕様・関連やりとり**を引き、ドキュメントがそれらに沿っているか照合する
4. 以下の観点でレビュー所見を組み立てて返す:
   - **整合性** — 既存 decision / 先行仕様との矛盾
   - **抜け漏れ** — 前提・制約・エラーケース・代替案の欠落
   - **前提** — 暗黙の前提・依存の明示性
   - **リスク** — 運用・セキュリティ・可逆性の懸念
5. 変更履歴が要るなら `doc-diff`（`source.history`）、決定の経緯は `decision-rationale` を併用する

## 制約

- read-only。Suasor からドキュメントを変更しない。**外部 SaaS / PR / コメントへの投稿は行わない**（観点を提示し、反映はユーザーに委ねる）
- 抽出未対応（name-only）の Office/PDF は本文をレビューできない。`[extraction]` を有効化して再 sync する（[guide/extraction.md](../../guide/extraction.md)）
- コード変更 / PR のレビューは `pr-review`、本文差分は `doc-diff` を使う
- 本 skill は手順書のみで実処理を持たない
