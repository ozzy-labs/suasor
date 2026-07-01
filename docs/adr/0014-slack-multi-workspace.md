# 0014. Slack multi-workspace（`[connectors.slack.workspaces.<alias>]`）

- Status: Accepted
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Tracking: [#50](https://github.com/ozzy-labs/suasor/issues/50) / epic [#53](https://github.com/ozzy-labs/suasor/issues/53)
- Related: [ADR-0007](0007-connector-contract.md)（connector / config）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（per-channel cursor / Slack 運用 verb / `FEATURE_SCOPES`）, [ADR-0038](0038-multi-workspace-shared-channel-dedup.md)（Enterprise Grid 共有チャンネルの owner-wins dedup）
- Prior art: opshub ADR-0041（slack-multi-workspace）

## Context

suasor は単一 `[connectors.slack]`（`team` + `channels` + 単一 token `connector:slack:token`）。1 install で複数 Slack workspace を取り込めない。本 ADR は multi-workspace 化の config / secret / cursor / CLI 形状を確定する。これは **config の破壊的拡張**を含むため ADR 先行が必須。本 epic の中で cursor / secret の基盤を最初に固める位置づけ（[#51](https://github.com/ozzy-labs/suasor/issues/51) / [#52](https://github.com/ozzy-labs/suasor/issues/52) はこの上に乗る）。

## Decision

1. **config: `[connectors.slack.workspaces.<alias>]` テーブル。** alias ごとに `team` / `channels` / `self_user_id`（[ADR-0012](0012-slack-demand-digest.md)）を持つ。flat `[connectors.slack]` は **default alias** として後方互換に読む（既存設定は無改修で動く）。
2. **secret: per-alias account `connector:slack:<alias>:token`。** env override も alias 込み（`SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN`）。default alias は既存 `connector:slack:token` を引き続き読む。
3. **cursor: per-workspace × per-channel。** [ADR-0011](0011-slack-operational-verbs-and-readiness.md) の per-channel cursor map を alias でネスト（`{ "<alias>": { "<channel>": "<ts>" } }`）。flat な per-channel map（旧形式）は default alias 配下として後方互換解釈する。
4. **CLI: `--workspace <alias>`。** `slack auth set/test` / `slack conversations` / `slack sync` に `--workspace` を追加。省略時は default alias（または唯一の alias）。`sync` は全 alias を **per-workspace エラー隔離**で直列処理し、1 workspace の失敗が他を止めない。
5. **`FEATURE_SCOPES` は workspace 非依存のまま不変。** readiness は per-workspace token で評価され、`auth test --workspace <alias>` が対象 token を切り替えるだけ（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) と一致）。

## per-resource エラー分離の非 Slack への一般化（[#193](https://github.com/ozzy-labs/suasor/issues/193)）

本 ADR 決定 (4) の **per-workspace エラー隔離**（1 sub-unit の失敗が他を止めない / 失敗 sub-unit の cursor 非リセット / 全失敗時のみ throw / 部分失敗は warn 集約 + `partialFailure` で exit 1）は Slack 固有ではなく、**複数リソースを 1 pass で走査する全 connector に共通する不変条件**である。github（repo）/ google（resource family）/ box（folder）/ ms-graph（resource family）も同じ分離を持つ（[#193](https://github.com/ozzy-labs/suasor/issues/193)）。従来これらは 1 リソース失敗で pass 全体を abort していた（1 repo の `403` が他 repo を巻き添え）。

- 共通実装は `src/connectors/per-resource.ts`（`syncResourcesIsolated`）に切り出し、各 connector のリソースループを包む。Slack は per-channel × per-workspace の二層 + membership 到達不能（[ADR-0011](0011-slack-operational-verbs-and-readiness.md)）という独自要件があるため、引き続き自前の隔離ロジックを保持する（共通ヘルパには寄せない）。
- cursor 非リセットの解釈は connector ごとに異なる：github は **共有 `since` cursor を成功 repo の最新 `updated_at` のみで前進**させ、失敗 repo の gap を次回 silent に skip しない。google / box / ms-graph は fingerprint ベース（cursor `null`）で前進そのものが無く、次回再走査で復旧する。
- warn / サマリ書式は Slack と統一（`<kind>: N OK, M failed (cursor preserved) — <resource> (<error>)` / `<kind>s: a=ok, b=failed (cursor preserved)`）。運用挙動の詳細は [connectors guide](../guide/connectors.md#per-resource-エラー分離github--google--box--ms-graph)。

## Consequences

### Positive

- 1 install で N workspace を取り込める。
- 既存 flat 設定は default alias として無改修で動く（後方互換）。

### Negative / Trade-offs

- cursor / secret の鍵空間が alias 込みになり、移行（flat → alias）の解釈ロジックが要る。
- `sync` の所要時間が workspace 数に比例（直列・エラー隔離前提）。

## Alternatives Considered

- **connector を alias ごとに別登録** — 却下。registry が動的になり、`FEATURE_SCOPES` / 運用 verb の共有が崩れる。1 connector + alias パラメタが筋。
- **flat 設定を廃止して alias 必須化** — 却下。既存ユーザーを破壊する。default alias による後方互換が必須。
