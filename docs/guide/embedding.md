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
```

env override も可能（headless / Docker 用、[config](../design/config.md)）:

```bash
export SUASOR_EMBEDDING__BACKEND=ollama
export SUASOR_EMBEDDING__MODEL=bge-m3
# export SUASOR_EMBEDDING__BASEURL=http://sidecar:11434
```

> **同一モデル必須**: 文書（ingest 時）とクエリ（query 時）の embedding は同じ `model` で生成する必要がある（ベクトル空間整合）。`model` を変えたら下記 4. で既存ベクトルを再生成する。現状 `ollama` のみ実装。`openai` / `voyage` は設定上受理されるが未実装で、`recall.search` は `embedding_disabled` に degrade する。

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

## トラブルシュート

- `recall.search` が常に空 + `embedding_disabled`:
  - `backend = "ollama"` になっているか（既定は `disabled`）
  - Ollama が起動し `baseUrl` で到達できるか（`curl <baseUrl>/api/tags`）
  - `model` を pull 済みか（`ollama pull <model>`）
- recall の精度が悪い / 取り込み直後にヒットしない:
  - backend を有効化する前に取り込んだ source はベクトルが無い → `suasor <connector> sync --full` で再生成
  - ingest と query で `model` が一致しているか（途中で変えたら `--full` で再生成）
