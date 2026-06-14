# Data Model

[ADR-0002](../adr/0002-event-sourced-architecture.md) に基づく event-sourced モデル。

## Event store（真実・追記専用）
- 単一の `events` テーブル（append-only）。1 行 = 1 ドメイン event
- event は Zod の **discriminated union**（`type` で判別、immutable、`schemaVersion` 付き）
- 例（暫定）: `SourceObserved` / `SourceBodyUpdated` / `ConnectorSyncCompleted` / `TaskProposed` / `TaskApplied` / `DecisionRecorded` / `ReplyDraftProposed` / `InboxItemTriaged`
- append 経路は raw SQL（`bun:sqlite`）。生 event を読み取り用途で直接引かない

## Projections（読みモデル・再構築可能）
- Drizzle 管理のテーブル。event を reducer で畳んで生成
- 暫定: `sources`（取り込み本文 + fingerprint + observed_at）/ `tasks` / `decisions` / `inbox` / `links`（関連グラフ）
- `sources_fts`（FTS5 仮想テーブル）/ `embeddings_vec_*`（`sqlite-vec` vec0、任意）
- **`suasor projections rebuild`** で全 event を replay し projection を同値復元

## Identity
- source の `external_id` は connector が付与（ソース横断で一意。workspace/team prefix が要る場合あり）（[ADR-0007](../adr/0007-connector-contract.md)）

## Migrations
- projection スキーマ変更は drizzle-kit。原則 **drop + rebuild**（replay）で吸収できるため in-place migration の比重は低い
