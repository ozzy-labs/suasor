# 0011. Slack operational verbs (auth test / conversations) and readiness

- Status: Proposed
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Related: [ADR-0007](0007-connector-contract.md)（connector contract — `sync()` 一本）, [ADR-0003](0003-local-first-and-content-minimization.md)（read 専用・書き戻し禁止）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP/HITL 境界）
- Prior art: opshub の Slack 実装（`slack auth test` の readiness capability model = opshub ADR-0040、token principal/scope = opshub ADR-0018、conversations discovery = opshub ADR-0041 §366）

## Context

現状の suasor Slack connector（`src/connectors/slack.ts`）は walking-skeleton の最小スライスで、Bot トークンを使い設定済み channel id に対して `conversations.history` を回すだけ。CLI は `init / db-migrate / connector-sync / projections-rebuild / search / mcp-serve / skills` のみで **Slack 専用の運用 verb を持たない**。この結果、オンボーディングに 2 つの穴がある:

1. **scope を検証する手段がない。** トークンに必要 scope（`channels:history` 等）が無くても、ユーザーは `sync` が黙って空を返すまで誤設定に気づけない（ADR-0007 の「silent wrong answer を出さない」方針に反する）。
2. **channel id を発見する手段がない。** 設定には channel id（`C0123…`）を手で書く必要があるが、id を一覧する経路がなく、`init` 直後に sync までたどり着けない。

加えて、現実装には**潜在的なデータ欠落バグ**がある。`SlackConnector` は `maxTs` を全 channel で共有し、次回 `oldest` に全 channel の最大 ts を渡す。活発な channel A（最新 ts=1000）と静かな channel B（最新 ts=500）が同居すると、次回 B は `oldest=1000` で絞られ、**500〜1000 の B の新着が恒久的にスキップ**される。

opshub（先行実装）はこれらを `slack auth test`（granted scopes + 機能別 readiness）・`slack conversations`（可視会話の列挙→設定ブロック出力）・per-channel cursor で解決済み。本 ADR はそのうち**オンボーディング基盤（Tier 1）と cursor 正当性修正**を suasor へ取り込む判断を記録する。

## Decision

1. **feature→scope の SSOT を TS の leaf モジュールとして持つ。** `src/connectors/slack/scopes.ts` に `FEATURE_SCOPES`（feature→required/recommended scope の単一表）と純粋関数 `assessReadiness(scopes, principal)` を置く。readiness は **scope 層のみの capability model**: 「granted scope が feature の scope 前提を満たすか」だけを答え、config も channel membership も読まず、追加 API も叩かない。`READY / READY(degraded: +<scope>) / MISSING <scope> / N/A(User Token only)` を返し、「scope があっても未参加 channel は `not_in_channel`」という membership 層の注意を footnote として一度だけ出す（過剰主張の回避、opshub ADR-0040 と同型）。

2. **運用 verb は Slack 固有 CLI コマンドとして実装し、汎用 connector contract は拡張しない。** `auth test` / `conversations` は `sync` ではなく運用操作なので、ADR-0007 の `Connector` interface（`sync()` のみ・import-clean）には足さない。代わりに次を追加する:
   - `suasor slack auth set` — トークンを keychain（`src/connectors/secrets.ts`、service `suasor`）へ保存。stdin hidden 入力に対応。
   - `suasor slack auth test` — `auth.test` でトークン検証 + `x-oauth-scopes` から granted scopes を取得 + `features:` readiness ブロックを stdout に出力（追加 round-trip なし）。
   - `suasor slack conversations` — `users.conversations` を列挙し、型別（public/private/im/mpim）に `missing_scope` を自己申告しつつ、`[connectors.slack]` に貼れる設定ブロックを出力。
   `@slack/web-api` は各コマンド内で lazy-import し、`--help` のコールドスタート予算を汚さない（ADR-0007）。

3. **per-channel cursor 化（正当性修正）。** cursor を「全 channel 共通の単一 ts」から「channel id → ts のマップ」へ変更し、Context の data-loss バグを解消する。`SyncResult.cursor` は opaque（ADR-0007）なので、JSON 化したマップを格納すればイベント表現は不変。

4. **本 ADR のスコープ境界。** demand digest（`slack.demand.list`）・engagement axis（`search:read`/User Token）・マルチワークスペース・thread replies・date floor は **本 ADR の対象外**（別 ADR / Issue）。特に demand digest は、suasor 同梱の `next-actions` / `personal-brief` skill が opshub 版と異なり**意図的に `slack.demand.list` を参照していない**ため、取り込みは skill スコープ拡大の独立した意思決定として扱う。

## Consequences

### Positive

- `init → slack auth set → slack auth test → slack conversations → sync` のオンボーディング導線が成立する。
- 誤設定が sync 前に検出でき、「黙って空」を回避（ADR-0007 整合）。
- per-channel cursor で静かな channel のデータ欠落が解消。
- 汎用 contract を太らせないため、他 connector に運用 verb の実装義務が波及しない。

### Negative / Trade-offs

- Slack 固有コマンドのぶん CLI 表面が増える（ただし他 connector が同種の verb を欲した時、共有ヘルパー化の判断が将来必要）。
- readiness は scope 層のみなので「membership まで保証する」誤読リスクが残る → footnote で緩和。

## Alternatives Considered

- **connector contract に `testAuth?` / `discover?` の optional hook を足す** — 却下。現時点で必要なのは Slack だけで、汎用 interface に投機的フックを足すと import-clean / 最小性（ADR-0007）が崩れる。複数 connector が必要になった時点で抽出する。
- **env トークン + 手動 id 発見のまま据え置き** — 却下。silent misconfig を残し、オンボーディングが完結しない。
- **readiness を config/membership 認識にする** — 却下。channel id 型解決に per-channel `conversations.info` が要り、`not_in_channel` を readiness に持ち込んで過剰主張になる（opshub ADR-0040 と同じ結論）。
- **ADR に feature→scope 表をデータとして持つ** — 却下。コード const と二重 SSOT になり drift する。
