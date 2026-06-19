# 0016. Slack sync date floor + cursor reset/backfill recovery verbs

- Status: Proposed
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Tracking: [#52](https://github.com/ozzy-labs/suasor/issues/52) / epic [#53](https://github.com/ozzy-labs/suasor/issues/53)
- Related: [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（per-channel cursor / Slack 固有運用 verb の方針）
- Prior art: opshub ADR-0036（slack-sync-date-floor）

## Context

初回 sync で channel 全履歴を引くと cold-start が膨大になり、API rate-limit と取り込み時間を圧迫する（[ADR-0015](0015-slack-thread-replies.md) の replies が加わるとさらに増える）。古いメッセージを取り込まない下限（date floor）が要る。あわせて、floor を後から緩めて過去を取り直す / cursor を巻き戻す運用 recovery verb が要る。

## Decision

1. **config: `[connectors.slack] sync_since`（+ per-channel override）。** 相対（`30d` / `4w`）または ISO 日付（`2026-01-01`）。cold-start / 初回 sync で floor より古いメッセージは fetch しない。per-channel override で channel ごとに floor を変えられる。multi-workspace 時は per-alias（[ADR-0014](0014-slack-multi-workspace.md)）。
2. **floor は per-channel cursor の下限として作用する。** [ADR-0011](0011-slack-operational-verbs-and-readiness.md) の per-channel `oldest` が未設定（初回）の channel では `oldest = max(sync_since, 既存 cursor)`。cursor が既にある channel は cursor 優先（floor で取り直さない）。
3. **floor 引き下げ時の一会限り gap-backfill。** floor を過去方向に緩めた次回 sync で、未取得 window を一度だけ取り込む（opshub の floor-lower gap-backfill と同型）。`--no-backfill` で抑制可能。
4. **recovery verb は Slack 固有 CLI（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) §2）。**
   - `slack cursor reset` — per-channel（`--channel`）または `--all` の cursor をリセット（次回 sync が floor から取り直す）。
   - `slack cursor backfill` — 指定 channel の floor を過去方向へ広げ、未取得 window を取り込む。
   - （任意）`slack status` — per-channel の cursor / floor を可視化。
5. **read-only / import-clean / per-channel cursor map との整合を維持。** recovery verb は cursor（イベント上の `ConnectorSyncCompleted.cursor`）を書き換える運用操作であり、外部 Slack には書き戻さない。

## Consequences

### Positive

- cold-start の取り込み量を floor で制御でき、rate-limit / 時間を抑制。
- floor 引き下げ・cursor 巻き戻しを verb で運用でき、取りこぼし回復が容易。

### Negative / Trade-offs

- cursor を書き換える recovery verb は破壊的になり得る（`reset --all` 等）。確認プロンプト / `--yes` で保護する。
- floor と cursor の優先順位ルール（cursor 優先）を正しく実装しないと、再 sync で取りこぼし / 重複が出る。

## Alternatives Considered

- **floor を持たず常に全履歴** — 却下。cold-start が大規模 channel で破綻する。
- **recovery を汎用 connector 契約に足す** — 却下。Slack 固有の cursor 構造に依存するため Slack CLI に置く（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) §2 の方針）。
