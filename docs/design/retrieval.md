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
- **メタフィルタ（任意・#142）**: `searchSources(sqlite, query, { sourceType?, observedAfter?, observedBefore?, limit? })`。`sourceType` は `sources.source_type` 完全一致、`observedAfter` / `observedBefore` は `observed_at` の窓（**下限 inclusive `>=` / 上限 exclusive `<`**、projection 読み取り tool と同一規約）。フィルタは JOIN 済み `sources` 行に対する WHERE で、**FTS / LIKE fallback の両経路に同一適用**（ランキングは不変、候補集合を絞るのみ）。フィルタ未指定時は従来結果と一致（additive）
- **戻り値**: `{ hits: SearchHit[], strategy: "fts" | "like-fallback", totalHits: number, truncated: boolean, analyzedQuery: string[] }`。`SearchHit = { externalId, sourceType, observedAt, score, body }`
- **透明性フィールド（ADR-0007「no silent wrong answer」）**: `totalHits` は `limit` 適用前の総マッチ数（`COUNT(*)`、ページが満杯のときのみ追加クエリ）で常に `>= hits.length`。`truncated` は `totalHits > hits.length`（`limit` で打ち切られたか）。`analyzedQuery` は実際に検索に使われたトークン列で、FTS パスでは whitespace 分割トークン、LIKE fallback では trimmed query を 1 要素に持つ配列。エージェントが「20/20 打ち切り」と「5/5 完全」を区別し、痩せ/空結果の原因を把握できるようにする

## Embedding（任意・サイドカー委譲）

実装は `src/retrieval/embedding/`（`embedder.ts` = thin client / `recall.ts` = vec0 populate + KNN search）。[ADR-0006](../adr/0006-ml-delegation.md) の ML 委譲不変条件に従い、`src/` にモデル実体を持たず**外部への薄いクライアント**のみ（torch なし）。

- backend: `disabled`（既定）/ `ollama` / `openai` / `voyage`。**`local`(in-process torch) は持たない**（[ADR-0006](../adr/0006-ml-delegation.md)）。3 backend とも実装済み。`openai` / `voyage` は外部 API（本文を送る egress・[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）で **API キー（keyring/env）でゲート**され、キー未設定時は embedder が `null` ＝ `recall.search` は `embedding_disabled` に degrade する（[Issue #259](https://github.com/ozzy-labs/suasor/issues/259)）
- `ollama` backend = `POST <baseUrl>/api/embed`（既定 `http://localhost:11434`、`bge-m3` 等の多言語モデル）。batch API（`{ model, input: string[] }` → `{ embeddings: number[][] }`）。egress なし
- `openai` / `voyage` backend = `POST <baseUrl>/v1/embeddings`（OpenAI 互換、`Authorization: Bearer <key>`、`{ model, input: string[] }` → `{ data: [{ index, embedding }] }`、index で入力順を復元）。既定 model は openai `text-embedding-3-small`(1536-dim) / voyage `voyage-3`(1024-dim)。**egress あり**（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）
- 文書 embedding（ingest 時）とクエリ embedding（query 時）は**同一モデル必須**（ベクトル空間整合）。`[embedding].model` が両者を駆動する単一の値で、`OllamaEmbedder` の 1 インスタンスが両方を埋め込むため model 混在は構造的に起きない
- ベクトルは `sqlite-vec` の `vec0`（`embeddings_vec_default`）に little-endian float32 blob で格納。upsert は `external_id` キーの delete-then-insert（FTS の sync と同じ流儀）。同時に provenance サイドカー `embeddings_meta`（`external_id` / `model_id` / `model_version` / `embedded_at`）へ生成 model を記録し、保守 verb の drift 検出に使う
- **populate（取り込み時）**: `syncConnector` が新規 / 本文変更 source のみを batch embed して vec0 へ書き込む（未変更は再埋め込みしない）。CLI `suasor <connector> sync` / MCP `connector.sync` の両経路で同一。embedding は **best-effort**: サイドカー失敗時も ingest は成功し（FTS は反映済み）、警告のみ出す（`onEmbedError` / CLI は stderr）
- **maintenance（保守）**: `embeddings status` / `rebuild` / `drain` / `find-duplicates`（[cli](cli.md) / [embedding guide](../guide/embedding.md)、#87）が埋め込み層を運用者から可視化・修復する。`status` は entity 種別ごとに embedded / pending / stale を集計、`rebuild` は `embeddings_meta` の記録 model が現行 `[embedding].model`（+ version）と異なる/欠落の source を再埋め込み（`--full` は全件）、`drain` は pending のみ catch-up、`find-duplicates` は vec0 ベクトル間 cosine 類似度の near-dup ペアを列挙する。実装は `src/retrieval/embedding/maintenance.ts`（SQL + thin embedder client のみ、ML はサイドカー委譲）
- **search（query 時）**: `recall.search`（[mcp-surface](mcp-surface.md)）が query を埋め込み、`vec0` の KNN（`WHERE embedding MATCH ? AND k = ?`）で最近傍を引き、`sources` を JOIN してメタ/本文を返す。`score` は L2 distance（小さいほど近い、best-first）
- **メタフィルタ（任意・#142）**: `recall.search` も `sourceType` / `observedAfter` / `observedBefore` を受ける。KNN は vec テーブルに `k = ?` を課す制約上、任意の述語を index に push できないため、**JOIN 済み `sources` 行への post-filter**で実装する: `limit * RECALL_FILTER_OVERFETCH`（既定 4 倍）の近傍を多めに引いてからフィルタし `limit` に trim する（フィルタで上位近傍が落ちても `limit` 件に届くようにするため）。時間窓の規約は FTS と同一（下限 inclusive / 上限 exclusive）

## Hybrid（FTS × 意味検索の RRF 融合・#142）

FTS-first（ADR-0005）を保ったままの additive 拡張。`search.hybrid` read tool が `search`（FTS）と `recall.search`（vec）を**それぞれ走らせ、2 つのランク済みリストを Reciprocal Rank Fusion（RRF）で融合**する。lexical（FTS: 完全一致・キーワード）と semantic（vec: 言語跨ぎ・語彙ミスマッチ）の盲点を相互補完する。

- **RRF（`src/retrieval/hybrid.ts` の純粋関数 `fuseRrf`）**: bm25（小さいほど良・無限）と L2 distance（小さいほど近）は**スケールが非互換**なため、生スコアではなく**順位**を融合する。各リストの 0-based rank に対し `1 / (k + rank)` を寄与とし、`externalId` ごとに全リストの寄与を合算（`k` は減衰定数、既定 `DEFAULT_RRF_K = 60`、原論文の慣用値）。**両リストにヒットした文書は両寄与を得て**、片側のみのヒットより上位に来る
- **dedup**: 同一 `externalId` は 1 エントリに融合（重複排除）。両リストに居る場合は **FTS 側 hit を代表**（lexical の `body` / `score` を保持）とする。融合結果は `rrfScore` 降順（best-first）、同点は `externalId` 昇順で決定的
- **純粋関数**: `fuseRrf(ftsHits, vecHits, { k?, limit? })` は SQLite / embedder に依存せず単体テスト可能。各入力は best-first 前提
- **graceful degrade**: embedding 無効 / サイドカー到達不能のときは **FTS のみで融合**（実質 FTS パススルー）し、`recall.search` と同じ `embedding_disabled` シグナルを返す（`search.hybrid` は hard error にしない）

## Graceful degradation

- `recall.search` は backend=disabled / 外部 backend のキー未設定（embedder が `null`）のとき **hard error にせず空 + `embedding_disabled` シグナル**を返す（`reason: "backend_disabled"`）→ host が `search`(FTS) に寄る
- backend 有効でも**サイドカー到達不能**（Ollama down 等）のときは同じく degrade（`reason: "backend_unreachable"`）。`signal` は常に `embedding_disabled` で host の fallback 判断は一貫
- `vec0` は基盤として常設（安価）。populate は backend 次第。`projections rebuild` は vec0 を truncate せず、`external_id` キーのベクトルは source 再構築後も有効なまま JOIN される（次回 ingest で再 populate）

## 使い分け

- 既知アイテム / キーワード → FTS（+ エージェント反復）
- 言語跨ぎ（JA↔EN）/ 語彙ミスマッチ → embedding（FTS が原理的に越えられない壁）
