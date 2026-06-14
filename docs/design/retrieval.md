# Retrieval

[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md) / [ADR-0006](../adr/0006-ml-delegation.md)。

## FTS-first（既定）

- `sources_fts`（FTS5 仮想テーブル）。日本語は trigram tokenizer 等で substring を拾う
- `search` tool が既定経路。エージェントが反復駆動できる

## Embedding（任意・サイドカー委譲）

- backend: `disabled`（既定）/ `ollama` / `openai` / `voyage`。**`local`(in-process torch) は持たない**（[ADR-0006](../adr/0006-ml-delegation.md)）
- `ollama` backend = `POST http://localhost:11434/api/embed`（bge-m3 等の多言語モデル）。egress なし
- 文書 embedding（ingest 時）とクエリ embedding（query 時）は**同一モデル必須**（ベクトル空間整合）
- ベクトルは `sqlite-vec` の `vec0` に格納

## Graceful degradation

- `recall.search` は backend=disabled 時に **hard error にせず空 + `embedding_disabled` シグナル**を返す → host が `search`(FTS) に寄る
- `vec0` は基盤として常設（安価）。populate は backend 次第

## 使い分け

- 既知アイテム / キーワード → FTS（+ エージェント反復）
- 言語跨ぎ（JA↔EN）/ 語彙ミスマッチ → embedding（FTS が原理的に越えられない壁）
