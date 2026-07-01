# 0011. Slack operational verbs (auth test / conversations) and readiness

- Status: Accepted
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Implemented: #46
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

## 追補（Issue #85）: auth verb を Slack 以外へ拡張

- Date: 2026-06-19
- Related: [Issue #85](https://github.com/ozzy-labs/suasor/issues/85)（非 Slack connector の auth set / auth test）

本 ADR は当初 auth verb を **Slack 専用**として実装した（決定 2 / scope 境界 4）が、github / ms-graph / google / box も token を持ちながら「保存 onboarding 導線が無く、`sync` 実行時にしか資格情報を検証できない」同じ穴を抱えていた（「黙って空」回避の方針に反する）。本 ADR の「複数 connector が必要になった時点で抽出する」方針（Alternatives 第 1 項）に従い、汎用の `<connector> auth set` / `<connector> auth test` verb を追加する判断を記録する。

- **保存層は再利用**: `auth set` は `src/connectors/secrets.ts` の `storeSecret`（connector 非依存）をそのまま使い、各 connector の primary secret（github=`token` / ms-graph=`clientSecret` / google=`refreshToken` / box=`token`）を keychain（`connector:<name>:<secret>`）へ保存する。`config.toml` には書かない（NFR-PRV-4）。
- **検証は connector ごとの最小 probe**: `auth test` は `src/connectors/<name>/auth.ts` の `fetch`-only round-trip（SDK 非依存・import-clean、ADR-0007）で資格情報の有効性を検証する。github=`GET /user`（`x-oauth-scopes`）/ ms-graph=client-credential token 交換 / google=refresh→access token 交換 / box=`GET /2.0/users/me`。token は error に出さない。
- **verb は data-driven**: `src/connectors/auth-specs.ts` の `AUTH_SPECS`（connector→secret 名 + probe）を SSOT に CLI 表面を派生する。汎用 connector contract（`sync` のみ）は引き続き太らせない（決定 2 と整合）。
- **Slack は別物として維持**: Slack は scope readiness（feature→scope の capability model）・マルチ workspace（ADR-0014）を持つため、汎用 verb には寄せず独自の `slack auth set/test` を維持する。汎用 `auth test` の readiness は「scope が報告されたか」程度の自己申告（`READY` / `MISSING` / `N/A`）に留め、過剰主張しない。

## 追補（Issue #194）: per-feature readiness を Slack 以外へ横展開

- Date: 2026-06-20
- Related: [Issue #194](https://github.com/ozzy-labs/suasor/issues/194)（auth test per-feature readiness 横展開）, [Issue #85](https://github.com/ozzy-labs/suasor/issues/85)（汎用 auth verb）

Issue #85 の汎用 `auth test` は readiness を「scope が報告されたか」の 1 行に留めた（上記）が、これでは「どの resource が実際に使えるか」（github の issue/PR・notifications、ms-graph の mail/calendar/files/teams、google の drive/gmail/calendar）が不明なままだった。Slack の feature→scope capability model（決定 1）を**非 Slack connector にも横展開**し、各 `auth test` に `features:` ブロックを Slack と同じ書式で出す判断を記録する。

- **判定モデルは Slack を一般化**: `src/connectors/auth-specs.ts` に純粋関数 `featureReadiness(spec, scopes)` を置く。Slack の**完全一致**トークンモデルと違い、非 Slack の scope は full URL（Google: `https://www.googleapis.com/auth/drive.readonly`）や粗粒度トークン（GitHub classic: `repo`）と異種なため、feature の `scopeNeedles` の**いずれかが granted scope 文字列の部分一致**なら `READY`、無ければ `MISSING <needles>`。scope 非列挙（`null`）は `N/A (scopes not enumerated)`（live probe で有効性は確認済み）。I/O・config 読み・追加 API なしの scope 層 capability model に留める点は Slack と同型。
- **connector ごとの feature→scope / resource マップ**:
  - **github**: granted scope（`x-oauth-scopes`）から `issue / pull request read`（`repo`）を常時、`notifications stream`（`notifications` | `repo`）を `notifications != "off"` の時のみ判定。fine-grained PAT は header を返さず `N/A`。
  - **ms-graph**: client-credential は `.default` を返し application permission を server 側解決するため**列挙不能**。config の `resources`（mail/calendar/files/teams）ごとに行を出し、各 row は `N/A (scopes not enumerated)`（実権限は Azure app registration で確認）。
  - **google**: token response が granted scope URL を列挙するため、config の `resources`（drive/gmail/calendar）ごとに scope 部分一致で `READY` / `MISSING`。
  - **box**: `users/me` は scope を持たないため `Box folder read: READY` の 1 行（scope ゲートなし）。
- **過剰主張の回避は維持**: `READY` は scope（または resource 設定）の自己申告のみで、resource への実到達（membership / folder 権限）は別レイヤ。Slack の membership footnote と同じ姿勢を保つ。`resources` 未設定の connector は `ingestion: N/A (no resources configured)` の 1 行で「何も取り込まない」状態を明示する。

## 追補（Issue #350）: Enterprise Grid の workspace 横断 discovery

- Date: 2026-07-01
- Related: [Issue #350](https://github.com/ozzy-labs/suasor/issues/350)（Enterprise Grid team_id 対応）, [ADR-0014](0014-slack-multi-workspace.md)（multi-workspace）

`slack conversations`（`users.conversations`）は `team_id` を渡していなかったため、Enterprise Grid で **org-level（org-wide app）token でも default workspace のチャンネルしか列挙されず**、他 workspace で参加中のチャンネルが静かに欠落していた。token 種別で成立可否が分かれるため、両対応の discovery に拡張する判断を記録する。

- **token 種別で分岐（両対応）**: `auth.test` の `is_enterprise_install` で org-level / workspace-level を判別する。
  - **org-level token**: `--team-id` 未指定なら `auth.teams.list`（org-wide app が承認された workspace を返す）で全 workspace を列挙し、各 `team_id` で `users.conversations` を sweep して workspace 別にグループ出力する。`--team-id <T…>` で単一 workspace に絞れる。
  - **workspace-level token**: Slack は `team_id` を無視し 1 workspace に束縛されるため、`--team-id` 指定時は silent no-op にせず warning を出し、ADR-0014 の per-workspace token（`--workspace <alias>`）経路を案内する。
- **列挙範囲の限界を明示**: `auth.teams.list` は「org-wide app が**承認された** workspace」を返す（user の全参加 workspace ではない）。非 Grid / 制限 / scope 不足時は空を返し、`auth.test` の単一 team に**フォールバック**する（enumeration は best-effort・sweep を失敗させない）。
- **config block は workspace 別**: 複数 workspace 発見時は `[connectors.slack.workspaces.<alias>]`（ADR-0014 形）を workspace ごとに出力し、各 id を自 workspace の `team` prefix 下に置く（identity は `slack:<team>:<channel>:<ts>`。flat block に束ねると sync 時に他 workspace の id を誤 prefix する）。alias は workspace 名を slug 化し衝突は suffix で解消。
- **discovery 限定 / sync 不変**: 本追補は discovery（`slack conversations`）のみ。sync は channel id 直接指定（グリッド内グローバル一意）+ per-workspace token 前提を維持し、team_id を必要としない。
- **import-clean 維持**: workspace 列挙は `src/connectors/slack/teams.ts` の `fetch`-only leaf（`slackFetch` 経由・SDK 非依存、ADR-0007 / ADR-0019）。
- **未検証事項**: `auth.teams.list` / `users.conversations` team_id の org-level token 実挙動は org-wide app token での実機検証が必要（本追補時点で未実施、ユニットテストは fake transport で網羅）。
