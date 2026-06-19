# 0015. Slack thread replies の取り込み（`conversations.replies`）

- Status: Proposed
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Tracking: [#51](https://github.com/ozzy-labs/suasor/issues/51) / epic [#53](https://github.com/ozzy-labs/suasor/issues/53)
- Related: [ADR-0007](0007-connector-contract.md)（connector 契約 / identity / 差分）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（per-channel cursor）
- Prior art: opshub `connectors/slack/fetcher.py`（replies 取り込み先行実装）

## Context

現状 connector は `conversations.history` のみ呼ぶ。スレッド親（`thread_ts`）は取り込むが、**返信は `conversations.replies` を別途叩かないと取得できない**ため、スレッド内の議論が欠落する。`thread_ts` は既に meta に保持済みなので、それを起点に replies を辿れる。

## Decision

1. **thread 親を起点に `conversations.replies` で返信を取り込む。** `history` で得たメッセージのうち thread 親（`reply_count > 0`、すなわち返信を持つもの）についてのみ `conversations.replies` を引く。返信を持たない大多数のメッセージでは叩かない（N+1 抑制）。
2. **identity は既存 schema を踏襲。** 返信も `slack:<team>:<channel>:<ts>`（ts は返信固有）/ `source_type: slack_message`。親返信関係は meta の `threadTs` で表現済み（追加 schema 不要）。
3. **差分検知は per-channel cursor に統合する。** 返信の取り込み下限も channel の `oldest`（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) の per-channel high-water mark）に従う。新規返信は ts が進むため、既知 ts はスキップ（既存 fingerprint / cursor 経路で吸収）。スレッド単位の別 cursor は持たない（複雑度を上げない）。
4. **read-only / import-clean を維持。** `conversations.replies` も read endpoint、`fetch` で叩く。

## Consequences

### Positive

- スレッド内の議論が欠落せず取り込まれ、検索 / brief / research の文脈が完全になる。
- 既存 identity / meta schema をそのまま使え、projection 変更が最小。

### Negative / Trade-offs

- thread 親ごとに追加 API が増える（返信を持つ親に限定して抑制するが、活発な channel では call 数が増える → [ADR-0016](0016-slack-sync-date-floor.md) の date floor / rate-limit 配慮と併走）。

## Alternatives Considered

- **全メッセージで `conversations.replies` を叩く** — 却下。返信を持たないメッセージにも叩く N+1 で API 浪費。`reply_count` で親を絞る。
- **スレッドごとに独立 cursor を持つ** — 却下。cursor 構造が複雑化。channel cursor + ts 進行で十分。
