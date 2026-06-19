# 0012. Slack demand digest（mention/DM signal）+ `slack.demand.list`

- Status: Accepted
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Tracking: [#48](https://github.com/ozzy-labs/suasor/issues/48) / epic [#53](https://github.com/ozzy-labs/suasor/issues/53)
- Related: [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP read 境界 / HITL）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（FTS-first）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（Slack 運用 verb・本 ADR の前段）
- Prior art: opshub ADR-0033（slack-mention-demand-digest）

## Context

Slack の @mention / DM は「読むべきだが未処理」という強い signal を持つ。opshub では `slack.demand.list` でこれを集約し、`next-actions` / `personal-brief` が priority 上位に組み込む（Phase 18-C）。

suasor の同梱 skill（`next-actions` / `personal-brief`）は opshub 版と異なり **意図的に `slack.demand.list` を参照していない**（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) §4）。本 ADR は (a) demand 信号を suasor に取り込むか、(b) 取り込む場合 assistant skill のスコープを広げてよいか、を確定する。これは実装詳細ではなく **製品スコープの判断**であり、ADR 先行が必須。

## Decision

1. **demand は既存 ingest からの projection で導出する（新規 fetch 経路を作らない）。** demand 行 = 取り込み済み `slack_message` のうち、(i) 本文に operator の `<@USERID>` mention を含む、または (ii) DM（`im`）に属する、かつ未処理（後述）のもの。`slack_demand` projection を `slack_message` から folding し、FTS-first（ADR-0005）で本文検索と統合する。Slack を追加で叩かない（read-only / local-first を維持）。
2. **operator identity は config で与える。** mention 判定に operator の Slack user id が要る。`[connectors.slack] self_user_id`（multi-workspace 時は per-alias、[ADR-0014](0014-slack-multi-workspace.md)）で設定し、`slack auth test` の出力（`userId`）から取得できるよう案内する。未設定なら mention demand は無効（DM demand のみ）に degrade。
3. **`slack.demand.list` は MCP read tool（ADR-0004）。** mention/DM の未処理 demand を時系列・priority 順で返す read-only tool。write は持たない。demand から task 化は既存 propose 経路（HITL、auto-apply なし）を使う。
4. **「未処理」は seen-marker ベースで host 側が解釈する。** demand projection は raw な mention/DM 行を返し、何を「処理済み」とみなすかは host（skill）側の seen-marker / 期間フィルタで決める。connector は状態を持たない。
5. **skill スコープ拡大を本 ADR で承認する。** `next-actions` / `personal-brief` の SKILL.md に「`slack.demand.list` を signal として組み込む」一文を追加する（opshub Phase 18-C と同型）。read tool のみ・task 化は HITL のままなので、ADR-0004 の境界は崩れない。

## Consequences

### Positive

- 追加 API 0 で demand を導出（local-first / read-only を維持）。
- `next-actions` / `personal-brief` が Slack の未処理 signal を反映でき、opshub と機能パリティ。

### Negative / Trade-offs

- mention 判定に operator user id の設定が要る（未設定は DM のみ degrade）。
- skill スコープが広がる（本 ADR で明示承認することで drift を防ぐ）。

## Alternatives Considered

- **専用 fetch 経路で mention を取得** — 却下。`search.messages`（User Token 専用）依存になり、ingest 済みデータから導出できるものを二重取得する。
- **demand を connector が状態管理（処理済みフラグ）** — 却下。connector は read-only / stateless（ADR-0003/0007）。seen-marker は host 側。
- **skill は触らず tool だけ追加** — 却下に近いが要判断。tool だけでは既存 skill が使わず死蔵する。本 ADR は skill 反映までを decision に含める。
