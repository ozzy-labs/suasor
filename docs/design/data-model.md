# Data Model

[ADR-0002](../adr/0002-event-sourced-architecture.md) に基づく event-sourced モデル。実装は `src/events/`（event 型 + store）/ `src/db/`（接続・schema）/ `src/projections/`（reducer + rebuild）。

## Event store（真実・追記専用）

- 単一の `events` テーブル（append-only）。1 行 = 1 ドメイン event
- event は Zod の **discriminated union**（`type` で判別、immutable、`schemaVersion` 付き）
- 確定 event 型（`schemaVersion = 1`）:
  - `SourceObserved` — connector がソース本文を初観測（read 専用取り込み）
  - `SourceBodyUpdated` — 既存ソースの本文変更（fingerprint/cursor で検知）。`SourceObserved` ともに**全文 body を保持**するため、event log から本文版履歴を復元できる（`source.history` read tool、#121）
  - `SourceForgotten` — source のローカル purge（[ADR-0026](../adr/0026-source-forgetting.md)・`externalId` / `reason?` のみで **body なし**）。reducer が `sources`/`sources_fts` を DELETE。あわせて過去の `SourceObserved`/`SourceBodyUpdated` の `body` は **redaction**（空白化）され、event log にも本文を残さない（append-only の明示的例外）
  - `ConnectorSyncCompleted` — sync 完了（`cursor` / `count` を保持。resume 用。成功 terminal でのみ append）
  - `SyncRunStarted` — sync run の開始（`connector` / `runId`（`<connector>:<startedAt>`）/ `startedAt`、[ADR-0033](../adr/0033-sync-run-history.md) / #201）。共有 `syncConnector` が run 開始時に発行
  - `SyncRunEnded` — sync run の終了（`connector` / `runId` / `status`（ok / partial / error）/ `observed` / `updated` / `unchanged` / `durationMs` / `error?`、[ADR-0033](../adr/0033-sync-run-history.md)）。**成功・失敗いずれでも append**（connector が throw した run も `status=error` で残る）ため、`ConnectorSyncCompleted` だけでは取れない「直近 sync が失敗」を鮮度ビューに表せる
  - `TaskProposed` — task 候補の提案（HITL・未適用。`dueDate?` / `priority?`（low / normal / high）の scheduling fields を持つ、[ADR-0028](../adr/0028-task-scheduling-fields.md) / #147。欠落時は null＝旧 event の replay 互換）
  - `TaskApplied` — 提案 task の承認・適用（`state`: open / in_progress / completed / dropped。`dueDate?` / `priority?` を任意に同時 (re)set。null は既存値を維持＝reducer が COALESCE、[ADR-0028](../adr/0028-task-scheduling-fields.md)）
  - `TaskPublished` — task を単一の外部ホーム（GitHub Issues（任意で Projects v2 board）/ Jira / Slack List）へ起票した記録（[ADR-0036](../adr/0036-task-external-home.md)・egress。`taskId` / `destination` / `externalId` / `publishedAt` のみで **body は持たない**。reducer が `tasks` の `published_*` 列＋`task → external_task` の `published_to` link を fold。`externalId` で冪等＝再起票 no-op）
  - `TaskActionIssued` — 公開済み task への状態操作（complete / reopen / comment）を外部ホームへ発行した監査記録（[ADR-0036](../adr/0036-task-external-home.md)・**body-less**。状態正本は外部ツール側＝projection なし＝reducer no-op、`DraftExported` と同型）
  - `DecisionRecorded` — 決定の記録（`rationale` + provenance）
  - `ReplyDraftProposed` — 返信下書きの提案（HITL・送信はユーザー手動）
  - `DraftExported` — 下書きをローカルファイルに書き出した監査記録（[ADR-0025](../adr/0025-local-draft-export.md)・`path` / `format`（`md`/`txt`/`docx`/`pptx`/`xlsx`、#138）/ `sourceExternalId?` のみで **body は持たない**。projection なし＝reducer no-op、replay でファイル再生成しない）
  - `InboxItemTriaged` — inbox item の仕分け（`state`: open / snoozed / done / dismissed）
  - `ProposalGenerated` — 提案候補の生成（`proposals` ledger に `pending` 記録、#89）
  - `ProposalRejected` — pending 候補の却下（`reason` 付き、#89）
  - `ProposalFeedback` — pending 候補への再生成ヒント記録（`reason` 更新・state は `pending` 据え置き、#279）
  - `LinkAdded` — 手動 link の作成（`linkId` + 端点。relation `manual_link`、[ADR-0018](../adr/0018-knowledge-graph-traversal.md) 追補 / #90）
  - `LinkRemoved` — 手動 link の削除（`linkId` 指定・監査可能）
  - `PersonIdentityObserved` — connector author handle を person に紐付け（1 handle = 1 person、[ADR-0022](../adr/0022-person-identity-resolution.md) / #92。sync が author から自動発行）
  - `PersonsMerged` — 2 person を 1 つに統合（HITL。source の identity を target へ付け替え・監査可能・可逆）
  - `PersonSplit` — 1 identity を別 person へ分離（merge の逆操作・HITL）
  - `CommitmentOpened` — commitment の確定登録（`commitmentId` / `title` / `direction`（owed_by_me / owed_to_me）/ `dueDate?` / `person?` + provenance、[ADR-0021](../adr/0021-commitment-ledger.md) / #91）
  - `CommitmentResolved` / `CommitmentDismissed` / `CommitmentReopened` — commitment の状態遷移（open ⇄ resolved / dismissed、HITL）
- 共通エンベロープ: `id`（ULID 風・時刻順ソート可）/ `recordedAt`（ISO 8601・store 時刻）/ `schemaVersion`
- append 経路は raw SQL（`bun:sqlite`、`src/db/events-table.ts`）。replay 順序は `seq`（AUTOINCREMENT）が正本
- 生 event を読み取り用途で直接引かない（projection 経由）

## Projections（読みモデル・再構築可能）

- projection テーブル（runtime DDL の正本は `src/db/connection.ts` の `initSchema`。`src/db/schema.ts` は同じ形を drizzle ORM 型として写したもの。両者の正本関係は「Migrations」節を参照）。event を reducer（`src/projections/reducer.ts`）で畳んで生成
- 確定テーブル:
  - `sources` — `external_id`(PK) / `source_type` / `body` / `fingerprint` / `observed_at` / `meta`(JSON)
  - `tasks` — `id`(PK) / `title` / `state`（`proposed` → `open` / `in_progress` / `completed` / `dropped`、`task.update` で遷移）/ `due_date` / `priority`（scheduling fields、[ADR-0028](../adr/0028-task-scheduling-fields.md) / #147。null 可。**overdue は焼かない**＝`due_date < now AND state ∈ {open, in_progress}` を `task.list` の read 時に派生）/ `published_destination` / `published_external_id` / `published_at`（外部ホームへの起票リンク、[ADR-0036](../adr/0036-task-external-home.md)。null＝未公開。`TaskPublished` が fold＝read-back / loop-avoidance の同一性リンク）/ `created_at` / `updated_at`
  - `sync_runs` — `connector`(PK) / `run_id` / `started_at` / `ended_at` / `status`（running / ok / partial / error）/ `observed` / `updated` / `unchanged` / `duration_ms` / `last_error`（connector 別の**最新 sync run** サマリ、[ADR-0033](../adr/0033-sync-run-history.md) / #201。`SyncRunStarted` / `SyncRunEnded` を畳む。`suasor sync status` が読む。**stale 判定は焼かず** read 時に最終 sync からの経過で導く）
  - `decisions` — `id`(PK) / `title` / `rationale` / `recorded_at`
  - `inbox` — `id`(PK) / `source_external_id` / `state` / `updated_at`
  - `proposals` — `candidate_id`(PK) / `mode` / `kind` / `entity_id` / `summary` / `state`（pending / applied / rejected）/ `reason` / `created_at` / `updated_at`（提案 lifecycle ledger、#89。`propose.list` が読む）
  - `commitments` — `id`(PK) / `title` / `direction`（owed_by_me / owed_to_me）/ `state`（open / resolved / dismissed）/ `due_date` / `person` / `created_at` / `updated_at`（commitment 台帳、[ADR-0021](../adr/0021-commitment-ledger.md) / #91。`commitment.list` が読む）
  - `links` — `id`(PK, autoinc) / `from_kind` / `from_id` / `to_kind` / `to_id` / `relation` / `link_id`（関連グラフ・provenance）。reducer 由来エッジ（`derived_from` / `replies_to` / `references`）は `link_id` が NULL、手動 link（`manual_link`、`link.add` / `link.remove`、[ADR-0018](../adr/0018-knowledge-graph-traversal.md) 追補 / #90）は安定 `link_id` を持ち id 指定で削除可能
  - `persons` — `id`(PK) / `display_name` / `identity_count` / `created_at` / `updated_at`（person 解決、[ADR-0022](../adr/0022-person-identity-resolution.md) / #92）。merge で空になった person は `identity_count = 0` で `person.list` から除外
  - `person_identities` — `identity_key`(PK = `<connector>:<handle>`) / `person_id` / `connector` / `handle` / `display_name` / `observed_at`（connector author handle → person。`person.merge` / `person.split` が `person_id` を付け替え）
- `sources_fts`（FTS5 仮想テーブル、`tokenize='trigram'` で JA/EN substring）/ `embeddings_vec_default`（`sqlite-vec` vec0、任意）/ `embeddings_meta`（vec0 と並ぶ provenance サイドカー: `external_id`(PK) / `model_id` / `model_version` / `embedded_at`。各ベクトルを生成した model を記録し、`embeddings status` / `rebuild` / `drain`（#87）の drift 検出に使う・[ADR-0006](../adr/0006-ml-delegation.md)）/ `extraction_meta`（document extraction の provenance サイドカー: `external_id`(PK) / `version` / `state`（per-source outcome: extracted / unsupported / too_large）/ `updated_at`。各 source の抽出本文を生成した extractor の version を記録し、後続の extractor upgrade（version bump）や新規 backend 有効化を drift として検知して次回 sync で再抽出する・[ADR-0024](../adr/0024-document-extraction-sidecar.md)。`source.forget` の purge 対象）。いずれも init 時に raw DDL で作成（drizzle-kit 管理外・event ではない派生 substrate）
- **`suasor projections rebuild`** で全 event を replay し projection を同値復元（rebuild idempotence、FR-MNT-1）

## Identity

- source の `external_id` は connector が付与（ソース横断で一意。workspace/team prefix が要る場合あり）（[ADR-0007](../adr/0007-connector-contract.md)）
- **person 解決**（[ADR-0022](../adr/0022-person-identity-resolution.md) / #92）: connector author handle（github login / slack `Uxxxx` / メールアドレス等）を person に解決。初期は **1 handle = 1 person**（自動 fuzzy 同定なし）。author key の抽出は `src/connectors/author.ts`（connector→meta key のマップ）が担い、sync が `PersonIdentityObserved` を発行。重複統合は HITL の `person.merge` / `person.split`（MCP write tool、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）でのみ行い event で監査・可逆

## Migrations

- **正本は `src/db/connection.ts` の `initSchema` raw DDL（`CREATE TABLE IF NOT EXISTS` + `ensureColumn` additive migration）。`suasor db migrate` はこれを呼び、runtime schema を作る唯一の経路**。projection table・FTS5・vec0・`embeddings_meta`・`extraction_meta` の全 substrate はここで作成される（[ADR-0002](../adr/0002-event-sourced-architecture.md)）
- **`drizzle/` artifact（`drizzle.config.ts` / `bun run db:generate` で `src/db/schema.ts` から生成）は適用されない参考成果物**。`suasor db migrate` は drizzle migration を一切実行しないため、`drizzle/*.sql` は型・スキーマ意図の確認用にとどまる（drift が生じ得るので runtime 正本として読まない）。`src/db/schema.ts` は drizzle ORM クライアントの型付け（`drizzle(sqlite, { schema })`）にのみ使い、ここでも DDL の正本は `connection.ts`
- 原則 **drop + rebuild**（replay）で吸収できるため in-place migration の比重は低い
- 既存 DB への**列追加**（例: tasks の `due_date` / `priority`、[ADR-0028](../adr/0028-task-scheduling-fields.md)）は init 時に冪等な `ALTER TABLE ... ADD COLUMN`（`PRAGMA table_info` で存在確認）で吸収する（SQLite に `ADD COLUMN IF NOT EXISTS` がないため）。`suasor db migrate` で適用、非破壊・冪等
