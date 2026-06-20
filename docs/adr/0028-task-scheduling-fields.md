# 0028. task scheduling fields（`dueDate` / `priority`）と overdue 派生

- Status: Accepted
- Date: 2026-06-20
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event-sourced / replay-stable）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP+HITL write）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（新 tool を作らず additive 拡張する流儀）, [ADR-0021](0021-commitment-ledger.md)（commitment `dueDate` と表現統一）
- Tracks: #147

## Context

commitment は `dueDate` を持つ（[ADR-0021](0021-commitment-ledger.md)）のに task は持たない非対称がある。「次に何をやる?」を支える `next-actions` skill（[ADR-0008](0008-assistant-skills.md)）が、最も強い優先度信号である**期限**を扱えていない。task に `dueDate` / `priority` を持たせ、overdue（期限超過）を surface することで、最小の追加で skill 横断の優先度判定が鋭くなる。

核心の緊張: overdue は**現在時刻に依存する状態**である。これを reducer で計算して projection に焼くと、別時刻の replay で値が変わり [ADR-0002](0002-event-sourced-architecture.md) の replay 不変性（rebuild idempotence・FR-MNT-1）が壊れる。

## Decision

1. **event payload に additive 追加** — `TaskProposed` / `TaskApplied` の payload に `dueDate: IsoDateTime.nullable().default(null)`（commitment と同表現）と `priority: z.enum(["low","normal","high"]).nullable().default(null)` を追加する。既定値があるため、これらを持たない**旧 event を parse すると null** に落ち、後方互換（replay 互換）が保たれる。`schemaVersion` は据え置き（純粋に additive・非破壊なため bump しない、[ADR-0002](0002-event-sourced-architecture.md) の upcast 不要）。

2. **projection に列を持つ（値は焼く）／overdue は焼かない** — `tasks` projection に `due_date` / `priority` 列を追加し、reducer の fold で値を反映する。`dueDate` / `priority` は event payload 由来の**時刻非依存**な値なので projection に焼いてよい。一方 **overdue は reducer では計算しない**。`dueDate < now AND state ∈ {open, in_progress}` を **query 層（read 時）で派生**し、`now` を注入可能にして決定論テストを成立させる。

3. **read tool は新設せず `task.list` を additive 拡張**（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md) の流儀）— `task.list` に `due_before`（`due_date < ?` フィルタ）と `overdue`（boolean、true で overdue のみ）フィルタを additive に足し、戻り値 task レコードに派生 `overdue` フィールドを加える。専用 read tool は作らない。

4. **write は `task.create` / `task.update` が `dueDate` / `priority` を受理（HITL）** — どちらも [ADR-0004](0004-mcp-agent-boundary-and-hitl.md) の write tool として、人の承認のもとで scheduling fields を受け付ける。`task.create` の id は従来どおり title + provenance 由来（`dueDate` / `priority` を id に含めない＝同一 task の期限変更で別 task に分裂しない）。

5. **push 通知（egress）は scope 外** — overdue を検知して外部に push する経路は本 ADR の対象外。read 時の surfacing に閉じる（[ADR-0003](0003-local-first-and-content-minimization.md) の egress 最小化に整合）。

## Consequences

### Positive

- 「やるべきこと」の最強信号である期限が task に乗り、`next-actions` の優先度判定が鋭くなる
- overdue を read 時派生に閉じることで replay 不変性（[ADR-0002](0002-event-sourced-architecture.md)）を保てる
- 新 tool を増やさず `task.list` の additive 拡張で済み、MCP surface を太らせない（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)）
- commitment の `dueDate` 表現と統一され、skill 側の期日処理が一貫する（[ADR-0021](0021-commitment-ledger.md)）

### Negative / Trade-offs

- projection 列が増え、reducer fold / query の分岐がわずかに複雑化
- overdue が read 時計算のため、`task.list` の各呼び出しで `now` 比較が走る（軽微）

## Alternatives Considered

- **overdue を projection 列に焼く** — 却下。現在時刻依存の状態を event store 由来の projection に焼くと、別時刻の `projections rebuild` で値が変わり replay 不変性（[ADR-0002](0002-event-sourced-architecture.md)）が壊れる。
- **専用 read tool `task.overdue` を新設** — 却下。`task.list` の additive フィルタで表現でき、新 tool は surface を太らせる（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md) の流儀に反する）。
- **`priority` を自由文字列にする** — 却下。enum（`low` / `normal` / `high`）にすることで skill 側の優先度関数が安定し、誤入力を弾ける。
- **後回し（drop）** — 非推奨。デイリー運用の「やるべきこと」可視化の中核で、最小コストで価値が高い。
