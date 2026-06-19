# Data Model

[ADR-0002](../adr/0002-event-sourced-architecture.md) に基づく event-sourced モデル。実装は `src/events/`（event 型 + store）/ `src/db/`（接続・schema）/ `src/projections/`（reducer + rebuild）。

## Event store（真実・追記専用）

- 単一の `events` テーブル（append-only）。1 行 = 1 ドメイン event
- event は Zod の **discriminated union**（`type` で判別、immutable、`schemaVersion` 付き）
- 確定 event 型（`schemaVersion = 1`）:
  - `SourceObserved` — connector がソース本文を初観測（read 専用取り込み）
  - `SourceBodyUpdated` — 既存ソースの本文変更（fingerprint/cursor で検知）
  - `ConnectorSyncCompleted` — sync 完了（`cursor` / `count` を保持。resume 用）
  - `TaskProposed` — task 候補の提案（HITL・未適用）
  - `TaskApplied` — 提案 task の承認・適用（`state`: open / in_progress / completed / dropped）
  - `DecisionRecorded` — 決定の記録（`rationale` + provenance）
  - `ReplyDraftProposed` — 返信下書きの提案（HITL・送信はユーザー手動）
  - `InboxItemTriaged` — inbox item の仕分け（`state`: open / snoozed / done / dismissed）
  - `ProposalGenerated` — 提案候補の生成（`proposals` ledger に `pending` 記録、#89）
  - `ProposalRejected` — pending 候補の却下（`reason` 付き、#89）
  - `LinkAdded` — 手動 link の作成（`linkId` + 端点。relation `manual_link`、[ADR-0018](../adr/0018-knowledge-graph-traversal.md) 追補 / #90）
  - `LinkRemoved` — 手動 link の削除（`linkId` 指定・監査可能）
  - `PersonIdentityObserved` — connector author handle を person に紐付け（1 handle = 1 person、[ADR-0022](../adr/0022-person-identity-resolution.md) / #92。sync が author から自動発行）
  - `PersonsMerged` — 2 person を 1 つに統合（HITL。source の identity を target へ付け替え・監査可能・可逆）
  - `PersonSplit` — 1 identity を別 person へ分離（merge の逆操作・HITL）
- 共通エンベロープ: `id`（ULID 風・時刻順ソート可）/ `recordedAt`（ISO 8601・store 時刻）/ `schemaVersion`
- append 経路は raw SQL（`bun:sqlite`、`src/db/events-table.ts`）。replay 順序は `seq`（AUTOINCREMENT）が正本
- 生 event を読み取り用途で直接引かない（projection 経由）

## Projections（読みモデル・再構築可能）

- Drizzle 管理のテーブル（`src/db/schema.ts`）。event を reducer（`src/projections/reducer.ts`）で畳んで生成
- 確定テーブル:
  - `sources` — `external_id`(PK) / `source_type` / `body` / `fingerprint` / `observed_at` / `meta`(JSON)
  - `tasks` — `id`(PK) / `title` / `state`（proposed → applied lifecycle）/ `created_at` / `updated_at`
  - `decisions` — `id`(PK) / `title` / `rationale` / `recorded_at`
  - `inbox` — `id`(PK) / `source_external_id` / `state` / `updated_at`
  - `proposals` — `candidate_id`(PK) / `mode` / `kind` / `entity_id` / `summary` / `state`（pending / applied / rejected）/ `reason` / `created_at` / `updated_at`（提案 lifecycle ledger、#89。`propose.list` が読む）
  - `links` — `id`(PK, autoinc) / `from_kind` / `from_id` / `to_kind` / `to_id` / `relation` / `link_id`（関連グラフ・provenance）。reducer 由来エッジ（`derived_from` / `replies_to` / `references`）は `link_id` が NULL、手動 link（`manual_link`、`link.add` / `link.remove`、[ADR-0018](../adr/0018-knowledge-graph-traversal.md) 追補 / #90）は安定 `link_id` を持ち id 指定で削除可能
  - `persons` — `id`(PK) / `display_name` / `identity_count` / `created_at` / `updated_at`（person 解決、[ADR-0022](../adr/0022-person-identity-resolution.md) / #92）。merge で空になった person は `identity_count = 0` で `person.list` から除外
  - `person_identities` — `identity_key`(PK = `<connector>:<handle>`) / `person_id` / `connector` / `handle` / `display_name` / `observed_at`（connector author handle → person。`person.merge` / `person.split` が `person_id` を付け替え）
- `sources_fts`（FTS5 仮想テーブル、`tokenize='trigram'` で JA/EN substring）/ `embeddings_vec_default`（`sqlite-vec` vec0、任意）。両者は init 時に raw DDL で作成（drizzle-kit 管理外）
- **`suasor projections rebuild`** で全 event を replay し projection を同値復元（rebuild idempotence、FR-MNT-1）

## Identity

- source の `external_id` は connector が付与（ソース横断で一意。workspace/team prefix が要る場合あり）（[ADR-0007](../adr/0007-connector-contract.md)）
- **person 解決**（[ADR-0022](../adr/0022-person-identity-resolution.md) / #92）: connector author handle（github login / slack `Uxxxx` / メールアドレス等）を person に解決。初期は **1 handle = 1 person**（自動 fuzzy 同定なし）。author key の抽出は `src/connectors/author.ts`（connector→meta key のマップ）が担い、sync が `PersonIdentityObserved` を発行。重複統合は HITL の `person.merge` / `person.split`（MCP write tool、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）でのみ行い event で監査・可逆

## Migrations

- projection スキーマ変更は drizzle-kit（`drizzle.config.ts` / `bun run db:generate` → `drizzle/`）。`events` 表・FTS5・vec0 仮想テーブルは drizzle-kit 管理外（init 時 raw DDL）
- 原則 **drop + rebuild**（replay）で吸収できるため in-place migration の比重は低い
