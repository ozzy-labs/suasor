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

1. **`SourceForgotten { externalId, reason? }` を append**（監査: 「いつ・何を・なぜ忘れたか」は残る。本文は含めない）。
2. **event redaction（append-only の明示的例外・本 ADR で許可）** — 当該 `externalId` の `SourceObserved` / `SourceBodyUpdated` の `body` を空文字に上書きする（`events` テーブルの限定的・監査可能な UPDATE）。redaction するのは `body` のみ（`fingerprint` / `observedAt` / `meta` は残す）。本文以外のメタが機密の場合の扱いは将来拡張。
3. **projection purge** — `sources` / `sources_fts` / `vec0`+`embeddings_meta` / `extraction_meta` から当該行を削除。
4. **links は残す** — 派生 link（task→source 等）は「今は無い source 由来」という provenance として有用なので残す（body だけ消える。`source.get` は null）。dangling 表示は許容。
5. **replay 整合** — redaction 後の event を replay すると body 空の purged 状態を再現する（replay-safe・[ADR-0002](0002-event-sourced-architecture.md) の「replay で同値収束」を維持）。
6. **HITL** — `source.forget(externalId, reason?)`（`readOnlyHint: false`、auto-apply なし）。idempotent（既 forget の再 forget は no-op）、未知 id は `missing` 報告。

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
