# 0026. source の forget（ローカル purge + event redaction）

- Status: Accepted
- Date: 2026-06-20
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event-sourced / append-only）, [ADR-0003](0003-local-first-and-content-minimization.md)（content-minimization）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（HITL）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（FTS/vec）
- Tracks: #141

> Status: **Accepted**（2026-06-20 レビュー反映後 承認）。実装: `SourceForgotten` event + reducer 駆動 delete + redaction + sidecar purge + `source.forget` tool。
>
> **改訂 R1（2026-07-06・#412）**: adversarial review で「forget の約束と実装の乖離」4 件（派生 content 残存 / 次回 sync での復活 / 非トランザクション実行 / 物理層の平文残存）が確定したため、Decision を **完全 forget** へ拡張（§改訂 R1）。

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

### 改訂 R1（2026-07-06・#412）— 完全 forget への契約拡張

検証で確定した乖離: (a) ingest は `sources` projection 行の不在だけで新規判定し `SourceForgotten` を見ないため、上流に残る source は**次回 sync で全文復活**する（`src/connectors/sync.ts` の fingerprint 判定）。(b) source 本文は `propose.generate` 時点で `ProposalGenerated.summary`（reply_draft は**全文**）へ、apply 時に `DecisionRecorded.rationale` / `ReplyDraftProposed.body` / task・commitment title へ verbatim で流れ、**reject した候補の本文まで**永続する。(c) 「1 トランザクション」（決定冒頭）に対し実装は 4 独立文で実行される。(d) redaction は論理層のみで、WAL / free page に平文が残存する（`secure_delete`/checkpoint なし）。これらを閉じるため以下を Decision に追加する:

1. **再取り込み防止（tombstone）** — `SourceForgotten` を折り込む `forgotten_sources` projection（externalId キー）を新設し、ingest（`runSyncPass`）は該当 externalId の再観測を**スキップ**する。明示的な再取り込みは新設の `source.unforget`（HITL write・tombstone 解除 event を append）でのみ行う。`source.forget` の応答は、当該 connector が enabled のままの場合「上流に残存していれば tombstone が再取り込みを防いでいる」旨を通知する。
2. **派生 content の cascade redaction（HITL）** — forget 時に links provenance（`derived_from` / `replies_to`、`idx_links_to`）と proposals ledger を辿り、派生 entity（task / decision / reply_draft / commitment / proposal summary / `DraftExported` パス）を**列挙して tool 出力で必ず開示**する。ユーザー確認を経た cascade 指定で、派生 event の自由文 field（title / rationale / body / summary）を元の決定 1（event redaction・`json_set` による空白化）と同じ方式で redaction する（append-only 例外の範囲拡張。対象 field は本項の列挙に限定）。開示は必須・cascade は HITL。
3. **reject 時の summary redaction（発生源対策）** — `propose.reject` は当該候補の `ProposalGenerated.summary` を redaction する（reply_draft では全文が入るため）。人が却下した本文を ledger に保持し続けない。forget と独立に適用する。
4. **原子性の遵守** — 決定冒頭の「1 トランザクション」は実装拘束である。`sourceForget` 全体を単一 sqlite transaction で包む（`store.record` は savepoint として入れ子可）。「steps are individually idempotent / retry で収束」を原子性の代替とする実装は本 ADR 違反とする。
5. **物理消去** — forget の最後に `PRAGMA wal_checkpoint(TRUNCATE)` を実行し、redaction / DELETE は `secure_delete` 有効化（または直後の incremental VACUUM）で行う。free page / WAL に redact 済み本文の平文が残らないことを契約に含める（forget は低頻度でコスト許容）。既存の `VACUUM INTO` backup・OS バックアップ・host 会話履歴など **Suasor の外に出た copy は forget の射程外**（Negative に明記）。

## Consequences

### Positive

- privacy-first（[ADR-0003](0003-local-first-and-content-minimization.md)）の必須機能が揃う（誤取り込み・機密・忘れられる権利）
- 本文は projection・event ログの双方から消える＝真の forget。監査 event は残り「何を忘れたか」は追える
- replay 後も purged 状態を再現（event-sourced の整合を維持）

### Negative / Trade-offs

- **append-only の例外**を 1 つ作る（redaction）。当初範囲は「forget 対象 source の body 上書きのみ」。**R1 で「その派生 event の自由文 field（cascade・HITL）+ reject 候補の summary」へ拡張**（対象 field は §改訂 R1 の 2・3 項の列挙に限定し、それ以外の event は不変を保つ）
- links が dangling（`source.get` null）になりうる（provenance 優先で許容）
- redaction は監査可能だが「過去の log を書き換える」操作なので、CLI/MCP の HITL ゲートと event（`SourceForgotten`）で必ず痕跡を残す
- **（R1）forget の射程外が残る** — `draft.export` 済みファイル・`VACUUM INTO` backup・OS バックアップ・host 会話履歴。tool 出力と本 ADR で明示的に開示する
- **（R1）物理消去は SQLite 実装依存**（`secure_delete` / checkpoint / VACUUM の挙動）。tombstone projection・`source.unforget` の追加面も増える

## Alternatives Considered

- **projection だけ purge（event は不変）** — 却下。event ログに本文が残り**真の forget にならない**（content-minimization に反する）
- **event 行を物理削除** — 却下。replay の連続性・他 event の seq/cursor との整合を壊す。redaction（body 空白化）の方が surgical で replay-safe
- **crypto-shredding（本文を暗号化し鍵破棄で forget）** — 却下（現状 over-engineering）。本文は平文ローカル保持（ADR-0003）で、redaction の方が単純
- **forget を持たない** — 却下。privacy-first を掲げる以上、必須
- **（R1）派生 content は「消えていない一覧」の開示に留める（誠実化のみ）** — 却下。ユーザーがこの機能に求める結果は一覧ではなく**消えていること**（「機密だから purge して」が flagship トリガー）。列挙は必須とした上で cascade redaction まで提供する
- **（R1）tombstone を持たず「connector スコープから外してから forget」を運用で要求** — 却下。どの surface もその前提条件を検査・通知しておらず、cron 定常運用では forget が無人で巻き戻る。構造で防ぐ
