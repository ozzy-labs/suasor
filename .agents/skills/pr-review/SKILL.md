---
name: pr-review
description: 「この PR レビューして」「#123 確認して」「PR どう思う」と頼まれたら、Suasor MCP の recall.search で関連 source / decision / 過去 review を引き、必要に応じて gh pr diff の出力を組み合わせてレビュー観点を提示する。read 系のみで構成し、PR への comment 投稿は外部送信扱いのため本 skill では行わない。
---

# pr-review

PR に対し、過去の決定・関連やりとりを踏まえたレビュー観点を提示する。read-only。

## いつ発火するか

- 「この PR レビューして」「#123 確認して」「PR どう思う」

## 何をするか（MCP tool flow）

Suasor MCP は read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。diff は host の `gh` CLI から取る。

1. `recall.search` で PR のトピックに関連する source / decision / 過去 review を引く（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
2. `decision.list` で当該領域の既存方針・決定を引き、PR がそれに沿っているか照合する
3. 必要なら host 側で `gh pr diff <N>` の出力を組み合わせて差分を読む
4. レビュー観点（過去決定との整合 / 関連やりとりとの矛盾 / 抜け）を提示して返す

## 制約

- read-only。Suasor から PR を変更しない
- **PR への comment 投稿は外部送信扱いのため本 skill では行わない**（HITL、[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。観点を提示し、投稿はユーザー / dev skill 側に委ねる
- 本 skill は手順書のみで実処理を持たない
