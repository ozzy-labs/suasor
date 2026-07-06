# 0015. Slack thread replies の取り込み（`conversations.replies`）

- Status: Accepted
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
3. **差分検知は per-channel cursor + per-thread high-water mark（改訂 R1・2026-07-06・#412）。** 当初は「スレッド単位の別 cursor は持たない。新規返信は ts が進むため、既知 ts はスキップ（既存 fingerprint / cursor 経路で吸収）」としたが、これは **dedup（再取得の重複排除）と capture（新規返信を取得できること）の混同**だった: 返信は「親が今回の `history` 窓に現れた場合」しか取得されず（非 broadcast 返信は `history` に現れない）、channel cursor が親 ts を追い越した後の新規返信 — **cron 定常運用での進行中スレッドの返信＝通常ケース** — には取得経路が存在しない。返信内の @mention が demand（[ADR-0012](0012-slack-demand-digest.md)）に届かない、中核信号の無音欠落である。
   改訂: 既存の per-channel cursor マップに **`<channel>#<thread_ts>` キーで active thread の high-water mark（最終取得返信 ts）** を持たせ、毎 sync、活動中スレッド（既定: 直近 30 日以内に活動。無活動で prune）へ `conversations.replies` を各スレッド自身の `oldest` で再ポーリングする。追加 API call は真に活動中のスレッド数に有界。cursor 形式の後方互換は要求しない。
4. **read-only / import-clean を維持。** `conversations.replies` も read endpoint、`fetch` で叩く。

## Consequences

### Positive

- スレッド内の議論が欠落せず取り込まれ、検索 / brief / research の文脈が完全になる。
- 既存 identity / meta schema をそのまま使え、projection 変更が最小。

### Negative / Trade-offs

- thread 親ごとに追加 API が増える（返信を持つ親に限定して抑制するが、活発な channel では call 数が増える → [ADR-0016](0016-slack-sync-date-floor.md) の date floor / rate-limit 配慮と併走）。
- （R1）活動中スレッドの再ポーリング分の API call が毎 sync 発生する（活動スレッド数に有界。30 日窓と prune で抑制）。
- （R1）Positive の「スレッド内の議論が欠落せず取り込まれ」は、R1 改訂によって初めて定常運用でも成立する（当初設計では cold-start と同一窓内の返信のみ成立していた）。

## Alternatives Considered

- **全メッセージで `conversations.replies` を叩く** — 却下。返信を持たないメッセージにも叩く N+1 で API 浪費。`reply_count` で親を絞る。
- **スレッドごとに独立 cursor を持つ** — 却下 → **R1（2026-07-06）で撤回し採用**。却下理由「channel cursor + ts 進行で十分」は dedup には成立するが capture には成立しない（決定 3 改訂を参照）。簡潔さと引き換えに中核信号を落としており、コストの置き場所が誤っていた。
