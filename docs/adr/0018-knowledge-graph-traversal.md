# 0018. Knowledge graph traversal — `graph.related` / `graph.expand`

- Status: Accepted
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event-sourced / projection）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP read 境界）, [ADR-0007](0007-connector-contract.md)（source identity）
- Prior art: opshub ADR-0017（Knowledge Graph：provenance の materialise + traversal）

## Context

`mcp-surface.md` は `graph.related`（関連 entity 辿り）を「後続 Issue」として未実装のまま残している。一方、同梱 skill が依存している: `decision-rationale`（「`graph.related` で decision から source / 先行 decision へ provenance を辿る」）/ `research`（「`graph.related` / `graph.expand` で関連 entity 拡張」）/ `meeting-prep`（「`graph.related` で関連 decisions / sources」）。これらは現状辿る術がなく degraded。

**重要: データ層は既に存在する。** suasor は `links` projection（`from_kind` / `from_id` / `to_kind` / `to_id` / `relation`、[db/schema.ts](../../src/db/schema.ts)）を持ち、reducer が provenance エッジを materialise 済み:

| relation | 例 |
|---|---|
| `derived_from` | task / decision → source（`sourceExternalIds`） |
| `replies_to` | reply draft → 返信元 source |
| `references` | proposal → source |

欠けているのは **`links` を辿る read tool** だけ。opshub ADR-0017 が「event payload の cross-entity ref を projection に materialise + traversal を公開」したのと同じ構図で、suasor は materialise 部分が済んでいるため **traversal tool のみ**が残差。

## Decision

1. **`graph.related`（1 hop）read tool。** 起点 entity（`kind` + `id`、例 `decision` / `<decisionId>`）を受け、`links` を **両方向**（from / to どちらにマッチしても）に 1 hop 引いて隣接 entity を返す。`relation` でフィルタ可。`readOnlyHint: true`。
2. **`graph.expand`（N hop）read tool。** 起点から幅優先で `depth`（既定 2、上限で cap）まで辿り、到達 entity + 経路エッジを返す。サイクルは visited set で防ぐ。
3. **`links` projection の上に薄い query で実装（新規テーブルなし）。** `queries.ts` に `listLinks(kind,id,{direction,relation})` / `expandGraph(kind,id,{depth,limit})` を足し、2 tool を登録。`SourceObserved` 等のイベントは不変。
4. **戻り値**: `graph.related` → `{ "origin": {kind,id}, "neighbors": [{kind,id,relation,direction}] }`。`graph.expand` → `{ "origin": {...}, "nodes": [{kind,id}], "edges": [{from,to,relation}] }`。entity の本文取得は既存 `source.get` 等に委ねる（graph は関係のみ返す）。
5. **将来のエッジ拡充は reducer 側で。** さらなる関係（task↔decision、inbox→task 等）が要るなら upsertLink を増やす別 Issue。本 ADR は **既存エッジの traversal 公開** に限定。

## Consequences

### Positive

- `decision-rationale` / `research` / `meeting-prep` skill の provenance 辿りが成立。
- 既存 `links` projection の再利用で、新規 schema・再 ingest なし。read tool のみ（ADR-0004）。

### Negative / Trade-offs

- 現状エッジ種は provenance 3 種（`derived_from` / `replies_to` / `references`）に限られる → 辿れる関係はその範囲。拡張は reducer 追補（別 Issue）。
- 深い `expand` は links 全走査になり得る → `depth` / `limit` で cap、index（`from_kind,from_id` / `to_kind,to_id`）を張る。

## Alternatives Considered

- **新規 graph projection / 専用 graph DB** — 却下。既存 `links` で足りる。over-engineering。
- **event log を都度 JOIN して辿る** — 却下。projection（links）が既にある目的を無視。遅く脆い。
- **graph で本文も返す** — 却下。関係のみ返し、本文は `source.get` 等に委譲（単一責務 / payload 抑制）。
