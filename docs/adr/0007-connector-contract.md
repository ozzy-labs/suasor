# 0007. Connector contract

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor は多数のソース（チャット・メール・カレンダー・ドキュメント・コード・Web）から取り込む。ソースごとに API は違うが、取り込みの形（read 専用・差分取得・source 同一性・本文保持）は共通化したい。

## Decision

connector は共通の **contract（TypeScript interface）** を実装する:

- **read 専用** — ソースに書き戻さない（[ADR-0003](0003-local-first-and-content-minimization.md)）
- **source identity** — ソース横断で一意な `external_id`（必要に応じ workspace/team を prefix）
- **差分取得** — delta API がある場合は cursor、ない場合は本文 fingerprint（SHA-256 等）で変更検知
- **本文取得** — 取り込んだ本文はローカルに保持（`sources` projection 等）
- **credential 解決は scope-emptiness 判定に先行する** — 下記参照
- 取り込みは event を append（[ADR-0002](0002-event-sourced-architecture.md)）、検索は projection 経由（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)）
- connector の登録 import は重い SDK を pull しない（lazy import / import-clean）
- connector ごとのプラットフォーム知識は **1 つの manifest（`ConnectorManifest`）に集約する** — 下記「connector manifest」参照

初期対象: GitHub(octokit) / Slack(@slack/web-api) / Microsoft Graph(@microsoft/microsoft-graph-client + @azure/msal-node) / Google(googleapis or fetch) / Box / Web(Playwright)。

### connector manifest（per-connector 知識の集約・#440）

> 改訂（2026-07-06, #440）。当初は per-connector 知識が 8 個の手書き name-keyed テーブル（registry の `SECRET_NAMES` / `BINARY_BUNDLED_CONNECTORS`、`noop-check` の `DETECTORS`、onboard の `CONNECTOR_SLICE_TEMPLATES`、`AUTH_SPECS`、`DISCOVERY_SPECS`、`CHANNEL_META_KEYS` / `TEAM_META_KEYS`）に分散し、**「connector が必要な全テーブルに登録されているか」を守る型もテストも無かった**。登録漏れは silent per-surface gap（noop 警告が出ない・onboard template が誤る・auth verb 欠落・doctor の credential check 欠落）を生み、コンパイルエラーにもテスト失敗にもならなかった（#298 で実バグ済み）。

各 connector は `ConnectorManifest`（`src/connectors/manifest.ts`）を **1 つ export** し、registry が集約する。manifest は connector ごとに以下を宣言する: `name` / `sourceType` / config schema / `secretNames` / `bundledInBinary` / scope-emptiness 述語（`noopWarning`）/ **必須の非 secret 設定キー（`requiredSettings`・[ADR-0049](0049-connector-readiness-parity.md)）**/ **multi-account 対応（`multiAccount`・[ADR-0050](0050-multi-account-connectors.md)）**/ onboard slice template / generic auth・discovery の参加可否（`genericAuth` / `genericDiscovery`）/ channel・team surface の参加可否（`surfacesChannels` / `surfacesTeams`）/ opt-out 理由（`capabilityNotes`）。

- **所有と宣言の分担（lazy-import 規律 NFR-PRF-1 の維持）**: eager-safe な pure data（scope-emptiness 述語・onboard template）は manifest が**所有**し、旧テーブル module は manifest に委譲する。lazy hot-path / ロジック保持テーブル（`SECRET_NAMES` / `BINARY_BUNDLED_CONNECTORS` は registry、`AUTH_SPECS` / `DISCOVERY_SPECS` はその module、channel/team meta は hot loop）はその場に残し、manifest は**参加可否を宣言**して完全性テストが突き合わせる。manifest module は connector module を eager import するが、connector module は top-level import-clean（`zod` + contract types のみ、重い SDK は `sync` 内 lazy import）なので SDK は pull しない。manifest module は registry / config / MCP-serve の hot path には載せない（CLI-path / 遅延ロードの consumer のみ）。
- **完全性テスト（#162 / #296 パターンの拡張）**: `connectorNames()` を回す parametrized test（`tests/connectors/manifest.test.ts`）が、各 manifest を全 surface と突き合わせるか、`capabilityNotes` で理由付き opt-out していることを assert する。10 個目の connector が surface を1つ忘れると、production で無音劣化する代わりに**テストが落ちる**。
- **Slack の fold**: Slack も同 manifest 形に capability flag で fold する。独自の auth（`slack auth set/test`, [ADR-0011](0011-slack-connector.md)）と discovery（`slack conversations`）を持つため generic surface を `capabilityNotes` 付きで opt-out し、`surfacesChannels` / `surfacesTeams` を true 宣言する（invisible な特例ではなく明示的な宣言になる）。

### credential 解決は scope-emptiness 判定に先行する

credential（token / secret 等）を要する connector の `sync` は、**credential 解決を「取り込みスコープが空か」（repos / folders / roots / urls / resources / databases / projects / jql 等が空）の判定より前に実行する**。credential が皆無なら、スコープの空・非空に関わらず **loud failure（throw → exit 1）** とする。

これは「credential 不在は無音 no-op でなく loud failure」という不変条件である。順序を誤り scope-emptiness を先に判定すると、enable 済みだが未設定の slice（スコープ空・token 未設定＝fresh-onboard 状態）で「0 件取り込み・exit 0・sync status ok」の silent success を返し、**欠落した credential が空スコープの陰に隠れる**（本 ADR の "no silent wrong answer" 違反）。

- **既存挙動の維持（回帰厳守）**: credential あり + スコープ空 → 従来どおり 0 件 no-op（client も build しない）。credential 皆無のときのみ throw に変わる。
- **multi-account connector**: 少なくとも 1 account に credential があれば全体 throw にはせず、token を欠く個別 account を per-account で skip（warning）する（per-account 隔離、[ADR-0014](0014-slack-multi-workspace.md) 準拠）。全 account 皆無のときだけ throw。
- **credential 不要な connector（`web` / `local`）は対象外** — token 概念が無いため scope 空は素直に no-op。
- 先行事例: Slack で #385 / PR #389 が実装、#404 で全 credential-connector（github / box / google / ms-graph / notion / jira）へ横展開。noop advisory（`src/connectors/noop-check.ts`・#187）は credential を見ない別レイヤ（advisory）で、本順序とは独立。
- **multi-account の一般化（改訂 2026-07-26, [#441](https://github.com/ozzy-labs/suasor/issues/441)）**: 上記「multi-account connector」の条項はもはや Slack 固有ではない。google / ms-graph / box（box は [#537](https://github.com/ozzy-labs/suasor/issues/537)）が `[connectors.<name>.accounts.<account>]` で複数アカウントを取り込むようになり（[ADR-0050](0050-multi-account-connectors.md)）、`Connector.credentials.secretNames` は**設定された account ごとに 1 名前**を並べる。any-of 意味論はそのまま: 全 account 皆無なら loud throw、個別欠如は connector 自身の per-account skip（warn 付き）に委ねる。共通実装は `src/connectors/multi-account.ts`、対応可否は manifest の `multiAccount` が宣言し completeness test が config schema と突き合わせる。
- **中央強制（改訂 2026-07-06, #440）**: この不変条件は当初、各 connector の `sync()` にコピペされた 13 行の comment+guard として存在した（#385 → #404 で 7 connector へ横展開）。#440 でこれを撤去し、各 connector が `Connector.credentials`（`CredentialRequirement` = 宣言 secret 名 + 欠如メッセージ、any-of 意味論）を宣言、sync service（`runSyncPass`）が `sync()` 反復の**前に**中央で解決・全欠如で throw する形へ移行した。any-of 意味論は単一 token connector（名前 1 つ）と multi-account Slack（設定 workspace ごとに 1 名前）を統一する: 全欠如は loud throw、個別欠如は connector 自身の per-account 隔離（tokenless workspace を warning 付き skip）に委ねる。新 connector は `credentials` を宣言するだけで強制を得る（コピペ不要）。

## Consequences

### Positive

- 新 connector を contract 実装 + manifest 1 つの追加で足りる（知識が 1 か所に集約）
- 取り込みの一貫性（identity / 差分 / 本文保持）が保たれる
- 完全性テストが surface 登録漏れを機械的に検出する（#298 クラスの silent gap を構造的に防止・#440）
- credential 不在の loud failure が全 connector で中央強制され、コピペ guard の drift が起きない（#440）

### Negative / Trade-offs

- delta のないソースは fingerprint 比較のコスト（取得後の検知）
- manifest module は connector module を eager import する（import-clean なので SDK は load しないが、CLI-path 限定に留める運用が必要）

## Alternatives Considered

- connector ごとにアドホック実装 → 却下。identity / 差分 / import-clean の一貫性が崩れる
