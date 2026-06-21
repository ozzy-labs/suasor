# Embedding (semantic recall)

Suasor の既定の検索は SQLite FTS5 の全文検索（`search` / `suasor search`）で、追加の依存なしで動く（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）。embedding は **任意の上乗せ** で、FTS が原理的に越えられない壁（言語跨ぎ JA↔EN・語彙ミスマッチ）を `recall.search` の意味検索で埋める。

ML はプロセス内で計算せず、**ローカルサイドカー（Ollama）または外部 API（OpenAI / Voyage）に委譲**する（[ADR-0006](../adr/0006-ml-delegation.md)）。Suasor 本体に torch 等の重い依存は入らない。

> **egress 注意（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）**: `ollama` はローカルサイドカーで **egress なし**（既定の推奨経路）。`openai` / `voyage` は本文（文書・クエリ）を外部 API に**送信する egress** を伴い、local-first / content-minimization の境界を跨ぐ。**明示的な opt-in**（backend 設定 + API キー設定）でのみ有効化され、API キーは config に平文で書かず **OS キーチェーン / 環境変数** で解決する（後述）。外部送信のプライバシー・コストを許容できる場合にのみ使う。

- 無効（既定）でも `search` は完全に動く。`recall.search` は空 + `embedding_disabled` シグナルを返し、host は `search` に寄る（graceful degradation）
- 有効化すると、取り込み時に新規 / 本文変更 source が埋め込まれて `recall.search` の対象になる
- backend が無効なまま `suasor search` / `suasor brief` を実行すると、意味検索が効かず FTS のみで検索している旨を **stderr に 1 行ヒント**する（stdout / `--json` は汚さない）。常時 FTS 運用なら無視してよい

## Ollama サイドカーのセットアップ

### 1. Ollama を入れて起動する

[Ollama](https://ollama.com) を導入し、サービスを起動する（既定で `http://localhost:11434` を listen）。

```bash
# モデルを取得（多言語・1024 次元。既定の model 名と一致）
ollama pull bge-m3

# サイドカーが起動していることを確認
curl http://localhost:11434/api/tags
```

`bge-m3` は JA / EN を含む多言語 embedding モデルで、言語跨ぎ検索に向く。別モデルを使う場合は下記 `model` を合わせる。

### 2. backend を有効にする

`~/.config/suasor/config.toml`（`SUASOR_CONFIG_DIR` で上書き）に `[embedding]` を追加する:

```toml
[embedding]
backend = "ollama"                  # disabled（既定）| ollama | openai | voyage（openai/voyage は egress・要 API キー）
baseUrl = "http://localhost:11434"  # /api/embed は client が付与
model = "bge-m3"                     # ingest と query で必ず同一（ベクトル空間整合）
dim = 1024                           # model の出力次元と一致必須（bge-m3=1024、nomic-embed-text=768 等）
# maxBatch = 64                       # 1 リクエスト最大件数。超過は順序保持で分割（Issue #267）
# requestTimeoutMs = 60000            # per-request timeout（ms）。超過は abort→retry（0 で無効）
# maxRetries = 3                      # 429/5xx の最大試行回数（初回含む）。1 で retry 無効
```

env override も可能（headless / Docker 用、[config](../design/config.md)）:

```bash
export SUASOR_EMBEDDING__BACKEND=ollama
export SUASOR_EMBEDDING__MODEL=bge-m3
# export SUASOR_EMBEDDING__BASEURL=http://sidecar:11434
```

> **同一モデル必須**: 文書（ingest 時）とクエリ（query 時）の embedding は同じ `model` で生成する必要がある（ベクトル空間整合）。`model` を変えたら下記 4. で既存ベクトルを再生成する。
>
> **backend の実装状況と egress**: 3 backend が実装済み — **egress-free な `ollama`（ローカルサイドカー）が既定の推奨経路**、加えて外部 API の `openai` / `voyage`。後者は本文を外部に送信する **egress を伴う**点で `ollama`（ローカル完結・egress なし）と非対称（[ADR-0003](../adr/0003-local-first-and-content-minimization.md) の境界を跨ぐ。[ADR-0006](../adr/0006-ml-delegation.md) の thin-client 不変条件には抵触しない）。`openai` / `voyage` は **API キー（OS キーチェーン / 環境変数）でゲート**され、キー未設定なら embedder は構築されず `recall.search` は `embedding_disabled` に degrade（FTS にフォールバック）し、**起動時（`suasor mcp serve`）と `suasor doctor` が「キー未設定」WARN を出す**（[Issue #235](https://github.com/ozzy-labs/suasor/issues/235) / [Issue #259](https://github.com/ozzy-labs/suasor/issues/259)）。外部 backend のセットアップは後述。
>
> **次元一致必須**: `dim` は `model` の出力次元と一致させる（`bge-m3`=1024、`nomic-embed-text`=768 等）。`dim` は DB 作成時に vec0 テーブルのサイズを固定するため、後から変える場合は新規 DB か delete + rebuild + 再 sync が必要。不一致のままだとベクトル挿入が失敗し、recall は静かに空へ degrade する。

### 3. 取り込み（ベクトルの populate）

backend を有効にした状態で connector を sync すると、新規 / 本文変更 source が自動で埋め込まれ `vec0` に格納される（未変更は再埋め込みしない）:

```bash
suasor github sync          # 取り込み + embedding populate
# 出力例: github sync: 12 observed, 3 updated, 5 unchanged, 15 embedded.
```

embedding は **best-effort**: サイドカーが落ちていても取り込み自体は成功し（FTS は反映済み）、警告だけが出る（`embedded` が 0 になる）。後でサイドカーを起動して再 sync すれば populate される。

### 4. 既存データへの後付け / モデル変更時の再生成

backend を後から有効化した、または `model` を変えた場合は、cursor を無視した全件再スキャンで全 source を再埋め込みする:

```bash
suasor github sync --full   # 全 source を再取り込み → 再 embedding
```

### 5. 意味検索

MCP `recall.search` read tool で意味検索ができる（[mcp-surface](../design/mcp-surface.md) / [retrieval](../design/retrieval.md)）。最近傍順（L2 distance 昇順）で hits を返す。embedding 無効・サイドカー到達不能のときは空 + `embedding_disabled` シグナルで FTS にフォールバックする。

## 外部 API バックエンド（OpenAI / Voyage）

Ollama サイドカーを用意できない環境向けに、外部 embedding API も使える。**本文を外部に送信する egress を伴う**ため（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）、明示的 opt-in（backend 設定 + API キー設定）でのみ有効化される。送信のプライバシー・コストを許容できる場合に限定して使うこと。

両 backend とも OpenAI 互換の `POST {baseUrl}/v1/embeddings`（`Authorization: Bearer <key>`、`{ model, input: string[] }` → `{ data: [{ index, embedding }] }`）を叩く thin client（[ADR-0006](../adr/0006-ml-delegation.md)・in-process ML 禁止）。

### モデル / 次元の対応表

| backend | 既定 model | dim | baseUrl 既定 | API キー env |
| --- | --- | --- | --- | --- |
| `openai` | `text-embedding-3-small` | 1536 | `https://api.openai.com` | `SUASOR_EMBEDDING_OPENAI_API_KEY` |
| `voyage` | `voyage-3` | 1024 | `https://api.voyageai.com` | `SUASOR_EMBEDDING_VOYAGE_API_KEY` |

> `model` を変えると次元が変わりうる（例 OpenAI `text-embedding-3-large` = 3072）。`[embedding].dim` を **その model の出力次元に必ず一致**させること。Ollama と同じく `dim` は DB 作成時に vec0 テーブルサイズを固定するので、後から変える場合は新規 DB か delete + rebuild + 再 sync が必要。ingest / query で同一 `model` を保つ不変条件も同じ（混在すると recall が壊れる）。

### 1. backend を設定する

`config.toml`（`model` / `dim` は使う provider に合わせる。API キーはここに**書かない**）:

```toml
[embedding]
backend = "openai"                  # または "voyage"
baseUrl = "https://api.openai.com"  # /v1/embeddings は client が付与（voyage は https://api.voyageai.com）
model = "text-embedding-3-small"    # ingest と query で必ず同一
dim = 1536                           # model の出力次元と一致必須（上表参照）
# maxBatch = 64                       # 大規模 sync で 413 / context 超過を避ける分割上限（Issue #267）
# requestTimeoutMs = 60000            # 外部 API のハングを防ぐ per-request timeout（ms）
# maxRetries = 3                      # 429/5xx の指数 backoff + jitter retry 回数（Retry-After 尊重）
```

### 2. API キーを設定する（keyring または env）

API キーは **config に平文で書かず**、connector secret と同じく **OS キーチェーン（`@napi-rs/keyring`）/ 環境変数**で解決する（NFR-PRV-4）。解決の優先順位は env override → OS キーチェーン。

env override（headless / Docker 用。最も手軽）:

```bash
export SUASOR_EMBEDDING_OPENAI_API_KEY=sk-...     # openai
export SUASOR_EMBEDDING_VOYAGE_API_KEY=pa-...     # voyage
```

OS キーチェーンに保存する場合は service `suasor` / account `embedding:<backend>:apiKey`（例 `embedding:openai:apiKey`）へ格納する。キー未設定だと embedder は構築されず `recall.search` は FTS にフォールバックし、`suasor mcp serve` 起動時 / `suasor doctor` が「キー未設定」WARN を出す。

> **`baseUrl` は `https://` 必須**: 外部 backend は API キーを毎リクエストの `Authorization` ヘッダで送るため、`http://`（平文）の `baseUrl` はキーを cleartext で漏らす。`openai` / `voyage` で `https://` 以外を設定すると **fail-closed で `EmbeddingError`**（`http://localhost` のみテスト / ローカルプロキシ用に許容）。

### 3. 取り込み・意味検索

以降は Ollama backend と同じ。`suasor <connector> sync` で新規 / 本文変更 source が外部 API で埋め込まれ（best-effort：API 失敗時も取り込みは成功し warning のみ）、`recall.search` の対象になる。既存データの後付け・model 変更時の再生成も同様に `suasor <connector> sync --full` / `suasor embeddings rebuild`。

## egress 堅牢化（retry / batch / timeout / 次元ガード）

外部 backend（`openai` / `voyage`）の egress は本番 sync に耐えるよう堅牢化されている（[Issue #267](https://github.com/ozzy-labs/suasor/issues/267)）。**送信内容は変えず**（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）、リクエスト形状と失敗時の挙動だけを足している。

- **retry / backoff**: `429`（rate limit）と `5xx`（サーバ）を**指数 backoff + full jitter**で再試行する。`Retry-After` ヘッダがあれば尊重（上限 60s）。最大試行回数は `maxRetries`（既定 3、初回含む。`1` で無効）。`4xx`（401/404 等）は config エラーとして即 fail（再試行しない）。共有ロジックは `src/util/retry.ts` にあり connector（slack/github の `_fetch.ts`）と同じポリシー。
- **batch 分割**: `maxBatch`（既定 64）を超える入力は**順序を保って分割**し、各 chunk の結果を結合する。1 リクエストに全件を詰めて 413 / model context 超過で**全ベクトルを失う**事故を防ぐ。
- **per-request timeout**: `requestTimeoutMs`（既定 60000ms）。外部 API がハングしても sync を止めない。timeout は abort して transient 失敗として retry する（`0` で無効）。
- **次元不一致 fail-fast**: `model` の実出力次元が `[embedding].dim` と異なる場合、**初回 embed で actionable な `EmbeddingError`**（「model は N-dim だが dim は M」「`dim = N` に直し新規 DB / delete + rebuild + 再 sync」）を投げる。従来は vec0 insert が静かに全失敗し recall が無言で空になっていた（例: `dim` 既定 1024 のまま `backend=openai` model `text-embedding-3-small`=1536）。`suasor doctor` も backend 有効時に 1 件 probe して「model 出力次元 vs `dim`」を検査し、不一致を ERROR で surface する（probe は外部 backend では 1 回の egress を伴う）。

> **cost 注意**: 外部 backend は本文を送る課金 egress。大規模 sync は `maxBatch` でリクエスト数が、retry で失敗時の追加リクエストが増える。コスト・レート制限を踏まえて値を調整する。

## 保守 verb（status / rebuild / drain / list-failed / find-duplicates）

埋め込み層は sync 時に自動 populate されるが、運用者から状態が見えにくい。`embeddings` サブコマンド（[ADR-0006](../adr/0006-ml-delegation.md)・[cli](../design/cli.md)）で可視化・修復する。各 source のベクトルがどの model で生成されたかは `embeddings_meta` サイドカー（vec0 と並ぶ派生 substrate・event ではない）が記録し、drift 検出に使う。

```bash
# 状態確認: entity 種別ごとに embedded / pending / stale を集計、有効 backend / model を表示
suasor embeddings status
# 出力例:
#   backend: ollama  model: bge-m3  auto: true
#     github_issue: 18/20 embedded, 1 pending, 1 stale
#     slack_message: 40/40 embedded, 0 pending, 0 stale
#     total: 58/60 embedded, 1 pending, 1 stale

# model を変えた後: 現行 model と異なる/欠落の source を再埋め込み（--full で全件）
suasor embeddings rebuild
suasor embeddings rebuild --full

# サイドカー停止中の sync で取りこぼした pending を catch-up
suasor embeddings drain

# どの source が未埋め込みかを列挙（status の pending / stale に対する drilldown）
suasor embeddings list-failed --limit 20
# 出力例:
#   2 source(s) missing a current-model vector:
#     [pending] github_issue  gh:42
#     [stale] slack_message  sl:7

# near-dup（cosine 類似度 >= 閾値）のペアを列挙（重複取り込みの発見）
suasor embeddings find-duplicates --threshold 0.95
```

- **status**: `embedded`（現行 model のベクトルあり）/ `pending`（ベクトル未生成）/ `stale`（別 model で生成済み）。backend 無効時は全件 pending として「有効化すれば何が埋め込まれるか」を示す。
- **rebuild**: 記録 model が現行 `[embedding].model`（+ version）と異なる/欠落の source を再埋め込み。settled な状態では冪等（再実行で 0 件）。`model` を変えたらこれ（または `--full`）を実行する。
- **drain**: ベクトル未生成の pending だけを catch-up（stale-but-present は rebuild の担当）。
- **list-failed**: `status` の roll-up に対する drilldown。現行 model ベクトルを欠く実際の source を `pending`（未生成→`drain`）/ `stale`（別 model→`rebuild`）付きで列挙する（pending 先頭、`--limit` 既定 50）。backend 無効時は全件 pending。
- **find-duplicates**: vec0 のベクトル間 cosine 類似度が `--threshold`（既定 0.95）超のペアを列挙する。実装は全ベクトルの **all-pairs 比較（O(n²)）** を JS で行う（`src/retrieval/embedding/maintenance.ts`）。インタラクティブな保守 verb 向けで、上限フィルタや近似 index は持たないため、**中規模 store 向け**（数千〜万件で重くなる）。大規模 store では実行時間とメモリに注意し、必要なら対象を絞って使う。
- 共通: `[embedding].backend` 無効時は全 verb が明示メッセージで no-op 終了。`rebuild` / `drain` の埋め込みは **best-effort**（サイドカー失敗は warning に留め、部分件数を返す）。`--json` で機械可読出力。

> `embeddings rebuild` / `embeddings rebuild --full` は §4 の `suasor <connector> sync --full` を再取り込みなしで置き換える（既存の取り込み済み source をそのまま再埋め込みするため connector を再スキャンしない）。新規取り込みも兼ねたい場合は引き続き `sync --full` を使う。
>
> **rebuild は既存 body の再 embed のみ・再抽出はしない**: `rebuild` は store 済みの body をそのまま再埋め込みする。Office/PDF の**本文を作り直す（再抽出）**のは connector sync の責務で、`[extraction].version` を bump した後などは `suasor <connector> sync`（drift で再抽出）が必要。embedding drift（`[embedding].model` 変更）と extraction drift（`[extraction].version` 変更）は別ドメインなので、本文が古い/欠けている時は rebuild ではなく sync を回す（[extraction guide](extraction.md)）。

## トラブルシュート

- `recall.search` が常に空 + `embedding_disabled`:
  - `backend = "ollama"` になっているか（既定は `disabled`）
  - Ollama が起動し `baseUrl` で到達できるか（`curl <baseUrl>/api/tags`）
  - `model` を pull 済みか（`ollama pull <model>`）
- recall の精度が悪い / 取り込み直後にヒットしない:
  - backend を有効化する前に取り込んだ source はベクトルが無い → `suasor embeddings drain`（pending のみ）または `suasor <connector> sync --full` で再生成
  - ingest と query で `model` が一致しているか（途中で変えたら `suasor embeddings rebuild`、または `sync --full` で再生成）
  - 現状を確かめたい → `suasor embeddings status` で embedded / pending / stale を確認、`suasor embeddings list-failed` でどの source が欠けているかを確認
  - `suasor doctor` は backend 有効時に未埋め込み backlog（`pending embeddings: N — suasor embeddings drain` / `stale embeddings: N — suasor embeddings rebuild`）を WARN で surface する。store 全体の規模（vec0 件数等）は `suasor store info` で確認できる
- `embedding dimension mismatch` / `recall` が常に空（backend 有効・キーあり）:
  - `[embedding].dim` が `model` の実出力次元と一致しているか（例 openai `text-embedding-3-small`=1536・voyage `voyage-3`=1024・bge-m3=1024）。不一致だと初回 embed で fail-fast し、`suasor doctor` が `embedding.dim` ERROR を出す
  - `dim` は DB 作成時に vec0 サイズを固定するため、変更には**新規 DB または delete + rebuild + 再 sync** が必要
