# Embedding (semantic recall)

Suasor の既定の検索は SQLite FTS5 の全文検索（`search` / `suasor search`）で、追加の依存なしで動く（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）。embedding は **任意の上乗せ** で、FTS が原理的に越えられない壁（言語跨ぎ JA↔EN・語彙ミスマッチ）を `recall.search` の意味検索で埋める。

ML はプロセス内で計算せず、**ローカルサイドカー（Ollama）または API に委譲**する（[ADR-0006](../adr/0006-ml-delegation.md)）。Suasor 本体に torch 等の重い依存は入らない。

- 無効（既定）でも `search` は完全に動く。`recall.search` は空 + `embedding_disabled` シグナルを返し、host は `search` に寄る（graceful degradation）
- 有効化すると、取り込み時に新規 / 本文変更 source が埋め込まれて `recall.search` の対象になる

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
backend = "ollama"                  # disabled（既定）| ollama | openai | voyage
baseUrl = "http://localhost:11434"  # /api/embed は client が付与
model = "bge-m3"                     # ingest と query で必ず同一（ベクトル空間整合）
dim = 1024                           # model の出力次元と一致必須（bge-m3=1024、nomic-embed-text=768 等）
```

env override も可能（headless / Docker 用、[config](../design/config.md)）:

```bash
export SUASOR_EMBEDDING__BACKEND=ollama
export SUASOR_EMBEDDING__MODEL=bge-m3
# export SUASOR_EMBEDDING__BASEURL=http://sidecar:11434
```

> **同一モデル必須**: 文書（ingest 時）とクエリ（query 時）の embedding は同じ `model` で生成する必要がある（ベクトル空間整合）。`model` を変えたら下記 4. で既存ベクトルを再生成する。現状 `ollama` のみ実装。`openai` / `voyage` は設定上受理されるが未実装で、`recall.search` は `embedding_disabled` に degrade する。
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

## 保守 verb（status / rebuild / drain / find-duplicates）

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

# near-dup（cosine 類似度 >= 閾値）のペアを列挙（重複取り込みの発見）
suasor embeddings find-duplicates --threshold 0.95
```

- **status**: `embedded`（現行 model のベクトルあり）/ `pending`（ベクトル未生成）/ `stale`（別 model で生成済み）。backend 無効時は全件 pending として「有効化すれば何が埋め込まれるか」を示す。
- **rebuild**: 記録 model が現行 `[embedding].model`（+ version）と異なる/欠落の source を再埋め込み。settled な状態では冪等（再実行で 0 件）。`model` を変えたらこれ（または `--full`）を実行する。
- **drain**: ベクトル未生成の pending だけを catch-up（stale-but-present は rebuild の担当）。
- **find-duplicates**: vec0 のベクトル間 cosine 類似度が `--threshold`（既定 0.95）超のペアを列挙する。
- 共通: `[embedding].backend` 無効時は全 verb が明示メッセージで no-op 終了。`rebuild` / `drain` の埋め込みは **best-effort**（サイドカー失敗は warning に留め、部分件数を返す）。`--json` で機械可読出力。

> `embeddings rebuild` / `embeddings rebuild --full` は §4 の `suasor <connector> sync --full` を再取り込みなしで置き換える（既存の取り込み済み source をそのまま再埋め込みするため connector を再スキャンしない）。新規取り込みも兼ねたい場合は引き続き `sync --full` を使う。

## トラブルシュート

- `recall.search` が常に空 + `embedding_disabled`:
  - `backend = "ollama"` になっているか（既定は `disabled`）
  - Ollama が起動し `baseUrl` で到達できるか（`curl <baseUrl>/api/tags`）
  - `model` を pull 済みか（`ollama pull <model>`）
- recall の精度が悪い / 取り込み直後にヒットしない:
  - backend を有効化する前に取り込んだ source はベクトルが無い → `suasor embeddings drain`（pending のみ）または `suasor <connector> sync --full` で再生成
  - ingest と query で `model` が一致しているか（途中で変えたら `suasor embeddings rebuild`、または `sync --full` で再生成）
  - 現状を確かめたい → `suasor embeddings status` で embedded / pending / stale を確認
