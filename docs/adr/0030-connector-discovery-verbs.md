# 0030. Connector discovery verbs (generic discovery base + `github repos`)

- Status: Accepted
- Date: 2026-06-20
- Deciders: Suasor maintainers
- Implemented: #190 / #211 / #214（v0.1.11）
- Related: [ADR-0007](0007-connector-contract.md)（connector 契約 — `sync()` 一本）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（Slack 運用 verb / `slack conversations` discovery）, [ADR-0029](0029-onboarding-wizard.md)（onboarding wizard / 非破壊 config append）, [ADR-0003](0003-local-first-and-content-minimization.md)（read-only）
- Tracks: #190 / Epic #185

## Context

Slack は `slack conversations`（[ADR-0011](0011-slack-operational-verbs-and-readiness.md)）で token から可視 channel id を列挙し、そのまま貼れる `[connectors.slack]` config ブロックを出力できる。これによりユーザーは channel id を手探りせずに済む。

ところが**他 connector はこの discovery 経路を持たない**。setup には次の識別子を手で書く必要がある:

- github: `repos = ["owner/repo"]`（リポジトリの完全名）
- google: `calendarId`
- box: `folderId`
- ms-graph: 対象 user / resource

これらは GitHub / Google / Box の Web UI を辿って手写しするしかなく、**typo すると sync が silent に 0 件**を返す（[ADR-0007](0007-connector-contract.md) の「no silent wrong answer」に反する）。連投 cross-connector 調査でも「id 手探り」が共通の onboarding gap として挙がっている。

Slack の `conversations` 実装（discovery leaf + `renderConfigBlock` + CLI verb）は他 connector でもそのまま転用できる形をしている。1 connector だけのために専用導線を都度書くより、**discovery を「connector が任意提供する operational verb」として一般化する基盤**を置き、その第 1 弾として `github repos` を実装する。

## Decision

**discovery を operational verb として一般化する。汎用 connector 契約（`sync()` 一本）は太らせず（[ADR-0007](0007-connector-contract.md)）、`auth set` / `auth test` と同型の data-driven な registry を介して connector ごとに任意提供する。第 1 弾として `suasor github repos` を実装する。**

1. **discovery registry を SSOT に持つ（auth-specs と同型）。** `src/connectors/discovery-specs.ts` に `DISCOVERY_SPECS`（connector → discovery spec）を置く。各 spec は:
   - `connector`: CLI verb prefix（例 `github`）
   - `verb`: discovery 動詞（例 `repos`）
   - `summary` / `itemNoun`: CLI usage と出力ラベル用の文字列
   - `discover(deps)`: `secret` resolver + `config` slice + 任意の `transport` を受け取り、`{ items, configBlock }` を返す probe。connector の `fetch`-only leaf（SDK 非依存・import-clean、[ADR-0007](0007-connector-contract.md)）を lazy-import して呼ぶ

   `auth set` / `auth test` が `AUTH_SPECS` から派生するのと同様、CLI 表面（`suasor <connector> <verb>`）はこの table から派生する。汎用 `Connector` interface（`sync()` のみ）には discovery hook を足さない（投機的フックは import-clean / 最小性を崩す — [ADR-0007](0007-connector-contract.md) Alternatives と整合）。

2. **config ブロック生成を共通化する。** Slack の `renderConfigBlock` と同じ「id を quote 値・人間可読ラベルを `#` コメント」方針を `src/connectors/onboard/config-block.ts` の純粋関数 `renderConnectorConfigBlock(connector, entries, extras)` に切り出す。各 discovery leaf はこのヘルパーで paste-ready な `[connectors.<name>]` ブロックを組む。これは [ADR-0029](0029-onboarding-wizard.md) の `appendConnectorSlice`（既存 slice 非破壊 append）と責務が分かれる: discovery は「貼る候補テキストを **生成**」、onboard は「config.toml へ **追記**」。両者の出力する slice 形（`enabled = true` を含む最小形）は揃える。

3. **第 1 弾 `github repos`。** `suasor github repos [--json] [--filter <substr>]`:
   - `GET /user/repos`（`per_page=100` + Link header ページング）を **`fetch` ベース**で列挙する（`octokit` 非依存、`src/connectors/github/auth.ts` と同じパターン）。leaf は `src/connectors/github/repos.ts`、transport 注入可能でテストする。
   - 各 repo の `full_name` / `visibility`（private/public）/ `archived` を出し、`full_name` をソートして paste-ready な `[connectors.github]` ブロック（`repos = [...]`、各行に `# <visibility>` コメント）を出力する。
   - `--filter <substr>` は `full_name` の部分一致（case-insensitive）で絞る。`--json` は items + configBlock を機械可読出力する（token は出さない）。
   - 認証は `auth test` と同じく keychain + env override の `token`。未設定なら明確なエラー（`suasor github auth set` を案内）で終了する。

4. **lazy-import 維持（NFR-PRF-1）。** discovery-specs / CLI コマンドの top-level import は clipanion + spec の **型 / 名前** のみに留める。keychain（`secrets.ts`）・config loader・discovery leaf（`fetch`-only）は `execute` 内で lazy-import する。discovery leaf 自体も `octokit` 等の heavy SDK を pull しない（`import-clean.test.ts` の静的ガード対象に `src/connectors/github/repos.ts` を含める）。

5. **registry への口。** discovery を提供する connector 名は `discoveryConnectorNames()`（`DISCOVERY_SPECS` のキー）で列挙でき、CLI ビルド時に `<connector> <verb>` コマンドを派生登録する（`src/cli/index.ts` の `connectorDiscoveryCommands()`）。提供しない connector は単に table に不在で、CLI 表面も生えない（段階導入可能）。

## Consequences

### Positive

- `auth set → auth test → <connector> <verb> で id 発見 → config 貼り付け → sync` の onboarding 導線が github にも成立し、typo による silent 0 件を回避できる。
- discovery が data-driven な registry に集約され、google `calendars` / box `folders` 等の後続も spec 1 件 + leaf 1 件の追加で生やせる。
- config ブロック生成が共通ヘルパーに集約され、Slack 含む全 connector で「id を貼る / `#` はラベル」の一貫した UX になる。
- 汎用 contract を太らせないため、discovery を持たない connector に実装義務が波及しない。

### Negative / Trade-offs

- connector ごとに discovery 動詞が異なる（github=`repos` / google=`calendars` 等）ため、`<connector> <verb>` の命名が connector 固有になる。これは Slack `conversations` 同様、対象 SaaS の語彙に合わせる方が自然と判断する。
- `GET /user/repos` は token が見える全 repo を返す（affiliation 既定）。大量 repo の account では出力が長くなるため `--filter` で絞れるようにする。
- Slack の `slack conversations` は本 ADR の共通基盤に**今回は寄せない**（既存の richer な実装 — 参加印 / engagement sort / multi-workspace — を壊さないため）。共通ヘルパー（config-block）への将来的な収斂は別 Issue とする。

## Alternatives Considered

- **connector contract に `discover?()` optional hook を足す** — 却下。[ADR-0011](0011-slack-operational-verbs-and-readiness.md) の auth verb と同じ理由で、汎用 interface に投機的フックを足すと import-clean / 最小性（[ADR-0007](0007-connector-contract.md)）が崩れる。data-driven な spec table で派生する。
- **github 専用に `slack conversations` 相当を 1 本だけ書く（基盤化しない）** — 却下。google / box / ms-graph も同じ id 手探り gap を抱えており、connector ごとに専用導線を都度書くと drift する。最初から薄い registry に載せる。
- **id 手探り + Web UI 手写しのまま据え置き** — 却下。typo silent 0 件を残し onboarding が完結しない（[ADR-0007](0007-connector-contract.md) 整合性）。
- **config ブロック生成を Slack の `renderConfigBlock` 流用で済ます** — 却下。Slack 版は `team` / `channels` 固有なので、connector 非依存の純粋ヘルパーに切り出して共有する。
