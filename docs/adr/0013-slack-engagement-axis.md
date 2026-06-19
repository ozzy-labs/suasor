# 0013. Slack engagement axis（`search.messages` / last_self_post、User Token）

- Status: Accepted
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Tracking: [#49](https://github.com/ozzy-labs/suasor/issues/49) / epic [#53](https://github.com/ozzy-labs/suasor/issues/53)
- Related: [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（`scopes.ts` に `engagement_axis` の readiness 判定は実装済み・本 ADR は実機能）
- Prior art: opshub ADR-0034（slack-engagement-axis）

## Context

[ADR-0011](0011-slack-operational-verbs-and-readiness.md) で `FEATURE_SCOPES.engagement_axis`（`required: ["search:read"]`, `userTokenOnly: true`）と `auth test` の `N/A (User Token only)` 判定は実装済み。だが **実機能**（engagement 順の会話並べ替え）は未実装。

engagement axis は「自分が最後に投稿した時刻（last_self_post）」で会話を並べ、関与度の高い会話を上位に出す軸。`search.messages`（`from:me`）で取得するが、`search:read` は **User Token（`xoxp-`）専用** scope で Bot Token では構造的に持てない。現状 connector は Bot Token 前提のため、User Token principal の取り扱いが要る。

## Decision

1. **User Token principal を一級で扱う。** token の principal（bot / user）は `auth.test` の `bot_id` 有無で判定済み（ADR-0011）。engagement 経路は principal=user のときのみ有効化し、bot のときは `N/A` を返す（readiness と一致）。token は既存 keychain account（`connector:slack:token`）を共有し、principal は実行時に解決する。
2. **last_self_post は `search.messages from:me` で導出する。** 会話ごとに operator の最新投稿 ts を引く。`slack conversations --sort=last_self_post`（または相当の order option）で engagement 順に並べる。取得は read-only（`search.messages` は read endpoint）。
3. **index lag を明示する。** Slack の全文 index には反映遅延がある。engagement 値は「概ねの最新関与」であり厳密でない旨を出力に注記する（opshub ADR-0034 と同じ注意）。
4. **import-clean を維持する。** `search.messages` も Slack SDK ではなく `fetch` で叩く（ADR-0011 の運用 verb と同じ方針）。

## Consequences

### Positive

- 「関与の濃い会話」を上位提示でき、`conversations` discovery の実用性が上がる。
- readiness（ADR-0011）と実機能が一致（`N/A` の根拠が実体を持つ）。

### Negative / Trade-offs

- User Token 前提のため Bot-only 運用では使えない（readiness が `N/A` を返すので誤解はない）。
- `search.messages` の index lag で engagement 値が厳密でない。

## Alternatives Considered

- **history から last_self_post を自前集計** — 却下。全 channel 全履歴の走査が要り、未参加/未取り込み会話を拾えない。`search.messages` が Slack 推奨経路。
- **Bot Token で代替 scope を探す** — 不可。`search:read` は User Token 専用（構造的制約、ADR-0034）。
