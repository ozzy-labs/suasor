# 0026. source の forget（ローカル purge + event redaction）

- Status: Proposed
- Date: 2026-06-20
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event-sourced / append-only）, [ADR-0003](0003-local-first-and-content-minimization.md)（content-minimization）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（HITL）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（FTS/vec）
- Tracks: #141

> Status: **Proposed**。本 ADR はレビュー用ドラフト。Accepted 後に実装 PR（`SourceForgotten` event + redaction + purge + `source.forget` tool）へ進む。

## Context

content-minimization / local-first（[ADR-0003](0003-local-first-and-content-minimization.md)）を掲げるのに、**取り込んだ特定 source をローカルから消す経路が無い**（誤取り込み・機密・「忘れられる権利」に対応できない）。

核心の緊張: `SourceObserved` / `SourceBodyUpdated` event は**全文 `body` を保持**する（`src/events/types.ts`・`source.history` がこれを読む）。projection を消しても **event ログに本文が残る**ため真の forget にならない。だが event ログは **append-only**（[ADR-0002](0002-event-sourced-architecture.md)）。

→ 真の forget には **event redaction**（特定 source の過去 event の `body` を空白化する制御された変更）が要る。これは append-only への**意図的な例外**であり、event-sourced システムの「忘れられる権利」対応の定石。本 ADR で境界を明文化する。

## Decision（ドラフト・レビュー対象）

**`source.forget`（HITL write tool）で、指定 source の本文を projection からも event ログからも消す。監査記録は残す。**

`source.forget(externalId, reason?)` は次を **1 トランザクション**で行う（HITL・`readOnlyHint: false`・auto-apply なし）:

1. **event redaction（append-only の明示的例外・本 ADR で許可）** — 当該 `externalId` の `SourceObserved` / `SourceBodyUpdated` の `body` を空文字に上書き（`events.payload` JSON に対し `json_set(payload, '$.body', '')`）。redaction するのは `body` のみ（`fingerprint` / `observedAt` / `meta` は残す）。これで**ログから本文が消える**。
2. **`SourceForgotten { externalId, reason? }` を append**（監査。本文は含めない）。**この event の reducer が `sources` / `sources_fts` 行を DELETE する**（次項参照）。
3. **削除は 2 層**（重要・replay 整合の肝）:
   - **event 由来 projection（`sources` / `sources_fts`）= `SourceForgotten` の reducer で DELETE**。`projections rebuild` は truncate → 全 event replay（`src/projections/rebuild.ts`）なので、redact 済み `SourceObserved`（body 空）が空行を再 insert → 末尾の `SourceForgotten` が再び DELETE → **最終状態は「行なし」**（replay-stable）。**imperative な tool 内 DELETE だけだと rebuild で空行が復活する**ため、必ず reducer 駆動にする。
   - **非 event の sidecar substrate（`vec0` / `embeddings_meta` / `extraction_meta`）= tool が imperative に DELETE**（replay 管理外。sync/embeddings 系と同じ扱い）。
4. **redaction と reducer-delete の両方が必要** — reducer-delete だけだと `SourceObserved.payload` に本文が残り content-minimization にならない。redaction だけだと rebuild で本文入りの行が復活する。両輪で「ログにも projection にも本文が残らない」を達成。
5. **links は残す** — 派生 link（task→source 等）は「今は無い source 由来」という provenance として有用なので残す（`source.get` は null）。dangling 表示は許容。
6. **idempotent** — 既 forget の再 forget は no-op（body は既に空・行は既に無い）。未知 id は `missing` 報告。

## Consequences

### Positive

- privacy-first（[ADR-0003](0003-local-first-and-content-minimization.md)）の必須機能が揃う（誤取り込み・機密・忘れられる権利）
- 本文は projection・event ログの双方から消える＝真の forget。監査 event は残り「何を忘れたか」は追える
- replay 後も purged 状態を再現（event-sourced の整合を維持）

### Negative / Trade-offs

- **append-only の例外**を 1 つ作る（redaction）。本 ADR で範囲を「forget 対象 source の body 上書きのみ」に限定し、それ以外の event は不変を保つ
- links が dangling（`source.get` null）になりうる（provenance 優先で許容）
- redaction は監査可能だが「過去の log を書き換える」操作なので、CLI/MCP の HITL ゲートと event（`SourceForgotten`）で必ず痕跡を残す

## Alternatives Considered

- **projection だけ purge（event は不変）** — 却下。event ログに本文が残り**真の forget にならない**（content-minimization に反する）
- **event 行を物理削除** — 却下。replay の連続性・他 event の seq/cursor との整合を壊す。redaction（body 空白化）の方が surgical で replay-safe
- **crypto-shredding（本文を暗号化し鍵破棄で forget）** — 却下（現状 over-engineering）。本文は平文ローカル保持（ADR-0003）で、redaction の方が単純
- **forget を持たない** — 却下。privacy-first を掲げる以上、必須
