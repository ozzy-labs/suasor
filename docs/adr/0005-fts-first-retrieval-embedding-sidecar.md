# 0005. FTS-first retrieval, embedding as an optional sidecar

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor は取り込んだ業務情報を、ユーザーと AI エージェントが MCP 経由で検索・要約できるようにする。検索手段として全文検索（FTS）と意味検索（embedding/ベクトル）がある。AI エージェントは賢く、キーワード検索を反復駆動できるため、embedding を必須にするかは設計判断になる。

## Decision

**FTS-first** を採る:

1. **既定の検索は SQLite FTS5**（日本語は trigram tokenizer 等で substring を拾う）。エージェントが反復駆動できる
2. **embedding は任意の enhancement**。有効化は **ローカルサイドカー（Ollama の `/api/embed` 等）経由**で行う（[ADR-0006](0006-ml-delegation.md)）。既定は無効
3. recall（意味検索）系は embedding 無効時に **FTS へ graceful 劣化**（エラーにせず、host が FTS に寄れるよう空＋シグナルを返す）
4. `sqlite-vec` の `vec0` は安価（~500KB）なので基盤として持つが、埋め込みの populate は backend 選択次第
5. **vec0 / `embeddings_meta` は replay 不能な sidecar substrate（追記 2026-07-06・#412）** — embedding は sidecar 呼び出しなしに event replay で再構築できないため、「projection は replay で再構築可能」（[ADR-0002](0002-event-sourced-architecture.md)）の対称では扱えない。よって `projections rebuild` は **vec0 と `embeddings_meta` を両方消去**し「全件 pending」という正直な状態に戻す（当初実装は vec0 のみ消して meta を残したため、`embeddings status` / `doctor` / `drain` の全 verb が「埋め込み済み」と偽り、recall が `reason:"ok"` のまま無音で全損した）。rebuild CLI は vec0 が存在する場合「`suasor embeddings drain` で復旧」を必ず案内し、`doctor` に vec0↔`embeddings_meta` 行数の整合チェックを追加して 2 substrate が再び無音で乖離しないようにする。復旧経路は既存の `embeddings drain` 一本。

embedding が効くのは FTS が原理的に越えられない壁（言語跨ぎ JA↔EN・語彙ミスマッチ）。

## Consequences

### Positive

- 既定で torch 等の重い依存ゼロ → 配布が軽い（[ADR-0010](0010-distribution.md)）
- embedding を使う場合もサイドカー経由で privacy 保全（[ADR-0003](0003-local-first-and-content-minimization.md)）かつ言語中立
- FTS-first ＋ サイドカーは graceful degradation で噛み合う

### Negative / Trade-offs

- embedding 無効時は意味検索の精度が出ない（エージェントの反復で補う）
- embedding 利用時はローカル model server（Ollama 等）への依存が増える
- （2026-07-06 追記）`projections rebuild` 後は re-embed 1 回分のコストが発生する（`embeddings drain` で一括。ローカル Ollama なら実費ゼロ・時間のみ）

## Alternatives Considered

- embedding を base 必須にする → 却下。重い依存を全員に強い、配布を痛める
- embedding を完全廃止（FTS のみ） → 却下。言語跨ぎ・語彙ミスマッチは FTS が原理的に越えられない
