# 0019. Slack fetch-path rate-limit retry (Retry-After-honoured)

- Status: Proposed
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Related: [ADR-0007](0007-connector-contract.md)（connector / import-clean）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（運用 verb・conversations）, [ADR-0013](0013-slack-engagement-axis.md)（search.messages）
- Prior art: opshub `connectors/slack/_retry.py`（`retry_on_rate_limit`：3 回・Retry-After 尊重・1s/2s/4s backoff を全 call site で共有）

## Context

Slack Web API は全エンドポイントを rate-limit する（429 + `Retry-After`）。suasor の Slack 呼び出しは 2 系統に分かれ、対応に差がある:

| 経路 | 実装 | 429 対応 |
|---|---|---|
| sync hot path（`conversations.history` / `conversations.replies`） | `@slack/web-api` `WebClient` | **あり**（SDK 既定の retry が Retry-After を尊重。suasor は `retryConfig` を無効化していない） |
| 運用/discovery（`users.conversations`・DM の `users.info`） | 生 `fetch`（`conversations.ts`） | **なし** |
| `auth.test` | 生 `fetch`（`auth.ts`） | **なし** |
| `search.messages`（engagement） | 生 `fetch`（`search.ts`） | **なし** |

fetch 経路は `await fetch(...)` → `body.ok` を見るだけで、429 / `Retry-After` / リトライ / バックオフが一切ない。結果:

- `users.conversations` が `ratelimited` → 非 scope エラーとして **throw**（列挙が落ちる）
- DM の `users.info` が `ratelimited` → `null` → `dm:<userId>` に **サイレント degrade**（名前が出ない）。DM 名前解決は DM ごとに逐次 `users.info` を発行するため、**最も 429 を踏みやすい経路**
- `auth.test` / `search.messages` → **throw**

opshub は `_retry.py` の共有ヘルパー `retry_on_rate_limit`（3 回・`Retry-After` 尊重・無ければ 1s/2s/4s backoff）で **全 fetch 経路を包んで**いた。suasor はこの層が欠けている。

## Decision

1. **共有 retry を fetch 層に置く（transport を包まない）。** Slack 専用の薄い `slackFetch(url, { token, fetchImpl?, sleep?, maxAttempts? })` を新設し、`conversations.ts` / `auth.ts` / `search.ts` の **default transport がこれを使う**。retry は HTTP status と header を見る必要があるため、body だけ返す transport ではなく fetch そのものを包む（最下層が `res.status` / `Retry-After` を読める）。
2. **ポリシーは opshub 準拠**: 既定 **3 試行**、`429` で `Retry-After` 秒を尊重（上限 cap）、ヘッダが無ければ **1s / 2s / 4s の指数 backoff**。`ok:false error:"ratelimited"`（200 で返る稀ケース）も同様に retry。それ以外のエラーは即時返す（呼び出し側の既存ハンドリングに委ねる）。
3. **sync 経路は二重に持たない。** `conversations.history` / `replies` は `@slack/web-api` の既定 retry に任せ、本 ADR の `slackFetch` では包まない（重複・競合回避）。本 ADR の scope は **fetch ベースの運用/discovery/auth/search 経路に限定**。
4. **import-clean / テスト容易（ADR-0007）。** `slackFetch` は SDK を読まず global `fetch` のみ。`fetchImpl` と `sleep` を注入可能にし、テストで「429→Retry-After→成功」「上限到達で最後の body を返す」を実時間待ちなしに検証する。
5. **観測性。** retry 発生時は呼び出し側の `onWarn` 等が無いため、`slackFetch` は静かに retry する（運用 verb は短命で、CLI が最終的に成功/失敗を出す）。将来 sync 中の 429 を可視化したくなれば別途。

## Consequences

### Positive

- 運用/discovery/auth/search が 429 で即死せず、Retry-After を尊重して回復。DM 名前解決の取りこぼしも減る。
- opshub とポリシー統一。今後 `users.*` / `conversations.*` の fetch 経路を足しても retry を継承。

### Negative / Trade-offs

- rate-limit 中は CLI が（最大数秒×試行ぶん）待つ。`Retry-After` 尊重なので過剰叩きはしない。
- sync 経路（SDK retry）と fetch 経路（`slackFetch`）で retry 実装が 2 つになる。ただし責務が分かれており（SDK の領分 vs 自前 fetch）、重複実装を避けるための意図的な分割。

## Alternatives Considered

- **全経路を `@slack/web-api` に寄せて SDK retry に統一** — 却下。運用 verb は import-clean のため意図的に SDK を使わず `fetch` のみ（ADR-0011）。SDK を operational 経路に持ち込むとコールドスタント/設計方針が崩れる。
- **transport（body 返し）を包む** — 却下。429 の `Retry-After` は HTTP header にあり、body だけ返す transport の外側からは見えない。fetch 層で包むのが正しい層。
- **無制限リトライ / 固定 sleep** — 却下。上限なしは hang リスク、固定 sleep は Retry-After 無視。opshub 準拠（3 回・Retry-After 優先・指数 backoff）が妥当。
