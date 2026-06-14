# Retrieval

[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md) / [ADR-0006](../adr/0006-ml-delegation.md)。

## FTS-first（既定）

- `sources_fts`（FTS5 仮想テーブル、`tokenize='trigram'`、contentless `content=''`）。日本語は trigram tokenizer で word segmenter なしに substring を拾う
- `sources` projection から reducer が維持する（`SourceObserved` / `SourceBodyUpdated` で delete-then-insert、`rebuild` で event log から再 populate）
- `search` tool が既定経路。エージェントが反復駆動できる

### search service（`src/retrieval/search.ts`）

`search` tool（[mcp-surface](mcp-surface.md)）と `suasor search` CLI が共有する読み取り専用サービス。`searchSources(sqlite, query, { limit })` → ランク済み hit。

- **クエリ正規化**: trim → 空白区切り token。各 token は phrase として `"..."` でクォートし（埋め込み `"` は `""` にエスケープ）、AND 連結する。`*` / `OR` / `-` 等の FTS5 演算子はリテラル扱い（インジェクション・構文エラー防止）
- **ランキング**: SQLite `bm25(sources_fts)` 昇順（よりマイナス＝より関連、best-first）。`sources` を JOIN して `source_type` / `observed_at` / `body` を返す
- **短クエリ fallback**: trigram は 3-gram のため、**最長 token が 3 code point 未満**のクエリは MATCH で 0 件になる。その場合 `sources.body` に対する `LIKE '%query%'`（`%` `_` `\` をエスケープ、`ESCAPE '\'`）substring scan に fallback し、`observed_at` 降順（recency）で返す。score は sentinel `0`。日本語の 1〜2 文字クエリ（例: 区・会議）もこの経路で拾える
- **境界**: 最長 token が **ちょうど 3 文字以上**なら FTS 経路。混在クエリ（例: `go home`）は最長 token（`home`）が条件を満たせば FTS 経路で全 token を AND する
- **0 件 / 空クエリ**: 空・空白のみのクエリは hard error にせず空 hit（strategy=`fts`）。マッチ無しも空 hit
- **戻り値**: `{ hits: SearchHit[], strategy: "fts" | "like-fallback" }`。`SearchHit = { externalId, sourceType, observedAt, score, body }`

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
