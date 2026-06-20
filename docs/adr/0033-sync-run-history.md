# 0033. sync run history & freshness (`SyncRunStarted` / `SyncRunEnded`, `suasor sync status`)

- Status: Accepted
- Date: 2026-06-21
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event-sourced・projection は replay 復元可能）, [ADR-0007](0007-connector-contract.md)（connector 契約・共有 `syncConnector` サービス）, [ADR-0027](0027-bulk-sync-orchestration.md)（`suasor sync` 一括・OS スケジューラ委譲）
- Tracks: #201 / Epic #185 / Phase 5

## Context

sync の鮮度が不可視である。最終 sync 時刻・直近の成否・取り込み件数が手元から確認できず、データが古いのか分からない。`suasor sync`（[ADR-0027](0027-bulk-sync-orchestration.md)）も `suasor <connector> sync`（[ADR-0007](0007-connector-contract.md)）も、結果（`SyncOutcome`）を **stdout に print してそのまま破棄**しており、履歴を残さない。定期実行を OS スケジューラに委譲した（ADR-0027）結果、スケジューラ側のログを見に行かない限り「いつ・何が・何件・成功したか」が Suasor から辿れない。

既存の `ConnectorSyncCompleted` event は resume 用の `cursor` と `count` を保持するが、これは **provenance（次回再開のためのカーソル）専用で projection を持たない**（reducer は no-op）設計であり、`status`（成功 / 失敗）や run の開始 / 終了時刻・duration を持たない。失敗で途中終了した run は `ConnectorSyncCompleted` を **append しない**（terminal イベントに到達しない）ため、「直近の sync が失敗した」という最も重要な信号がそもそも記録されない。

event-sourced（[ADR-0002](0002-event-sourced-architecture.md)）に沿えば、sync の実行履歴は **event として追記**し、鮮度ビューは **projection として replay 復元可能**に保つのが一貫した設計である。

## Decision

**sync の実行を `SyncRunStarted` / `SyncRunEnded` の 2 event として記録し、connector 別の最新実行サマリを `sync_runs` projection に畳む。鮮度は `suasor sync status [--json]` で表示する。**

1. **2 つの新 event（`schemaVersion = 1`）を追加する。** 共有 `syncConnector` サービス（`src/connectors/sync.ts`）が run の開始時に `SyncRunStarted`、終了時（成功・失敗いずれも）に `SyncRunEnded` を append する。CLI 単体 sync・`suasor sync` 一括・`connector.sync` MCP tool はすべてこのサービスを通るため、入口に依らず同一に記録される（[ADR-0007](0007-connector-contract.md) 単一コードパス）。
   - `SyncRunStarted` — `connector` / `runId`（content-derived: `<connector>:<startedAt>`、安定・冪等）。
   - `SyncRunEnded` — `connector` / `runId` / `status`（`ok` / `partial` / `error`）/ `observed` / `updated` / `unchanged` / `durationMs` / `error?`（失敗時のメッセージ）。
   - run が connector の throw で異常終了した場合も、呼び出し側（`syncConnector`）は `finally` 相当で `SyncRunEnded(status=error)` を append してから re-throw する。これにより **失敗した run も履歴に残る**（ADR-0027 の continue-on-error / exit-code 規約と独立）。

2. **`sync_runs` projection（connector を PK とする最新実行サマリ）を追加する。** reducer は connector 別に「最後に観測した run」を upsert する: `SyncRunStarted` で `started_at` / `status='running'` を、`SyncRunEnded` で `ended_at` / `status` / 件数 / `duration_ms` / `last_error` を確定する。replay 安定: event 列を順に畳めば同値復元できる（[ADR-0002](0002-event-sourced-architecture.md) FR-MNT-1）。**現在時刻に依存する派生（"stale かどうか" 等）は projection に焼かず**、read 時（`sync status`）に計算する（ADR-0028 の overdue 派生と同じ方針）。

3. **`suasor sync status [--json]` を追加する。** `sync_runs` projection を connector 別に読み、「最終 sync 時刻（`ended_at`）・件数（observed/updated/unchanged）・直近の成否（status）・所要時間」を表示する。未 sync の connector（行なし）は "never synced" と表示する。`--json` で機械可読出力（cron 監視・他ツール連携向け、ADR-0027 の `--json` 方針と一貫）。読み取り専用・自律 OK（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md) read = 非破壊）。

4. **次回予定（next run）は best-effort。** 定期実行は OS スケジューラに委譲しており（ADR-0027）、Suasor は自前のスケジュール状態を持たない。スケジューラ設定（cron 行 / systemd timer）を Suasor から確実に読む一般的手段はないため、本 ADR では **next run を表示しない**（将来 onboarding が書き出した scheduler 設定を読めれば追補する）。鮮度判断は「最終 sync からの経過」で十分に賄える。

5. **`ConnectorSyncCompleted` は残す。** resume cursor の provenance として既存役割を持ち続ける（reducer no-op のまま）。sync 履歴 / 鮮度は新 event が担い、責務を分離する（cursor = 再開、run history = 鮮度・監査）。

## Consequences

### Positive

- 最終 sync 時刻・件数・直近の成否が `suasor sync status` で一目で分かる。鮮度の可視化という中核ニーズを満たす
- **失敗した run も履歴に残る**（`SyncRunEnded(status=error)`）。`ConnectorSyncCompleted` だけでは取れなかった「直近 sync が失敗」を捕捉できる
- event-sourced を崩さない: 履歴は追記 event、鮮度ビューは replay 復元可能な projection（ADR-0002 一貫）
- 共有 `syncConnector` に記録を寄せるため、CLI 単体 / 一括 / MCP の全入口で自動的に履歴が残る（ADR-0007 単一コードパス）
- `--json` で cron 監視・外部ツール連携に乗せられる（ADR-0027 と一貫）

### Negative / Trade-offs

- event 種別が 2 つ増える（`SyncRunStarted` / `SyncRunEnded`）。sync 1 回ごとに 2 event 追記され、event log が増える（件数は connector × sync 回数で、cursor event と同程度の増加に留まる）
- next run（次回予定）は表示しない（OS スケジューラ委譲の帰結）。鮮度は「最終 sync からの経過」で代替する
- `ConnectorSyncCompleted` と `SyncRunEnded` が両方 append され、count が二重に記録される（cursor 用 / 鮮度用で読者が別なので冗長は許容）

## Alternatives Considered

- **`ConnectorSyncCompleted` を拡張して status / 時刻を持たせる** — 却下。`ConnectorSyncCompleted` は **成功 terminal でしか append されない**ため、失敗 run を記録できない。run の開始 / 終了を 2 event に分けることで、途中失敗も「started はあるが ended が error」として残せる。また cursor（再開）と run history（鮮度）は読者・責務が異なるため分離する方が素直
- **projection を持たず `sync status` で event log を都度集計** — 却下。connector 数 × sync 回数の event を毎回スキャンするのは read コストが線形に増える。最新実行サマリを projection に畳めば read は connector 数の定数 SELECT で済む（ADR-0002 の projection 方針に一致）
- **常駐プロセスで next run を管理** — 却下。ADR-0027 が常駐デーモンを意図的に避けた方針と矛盾する。スケジューリングは OS に委譲したまま、鮮度は実行履歴から導く
