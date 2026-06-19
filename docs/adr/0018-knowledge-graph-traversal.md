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

## 追補（#90）: 手動 link CRUD — `link.add` / `link.remove`

本 ADR の決定 5 は「将来のエッジ拡充は reducer 側で（別 Issue）」とした。[Issue #90](https://github.com/ozzy-labs/suasor/issues/90) はその第一弾として、**自動導出（`derived_from` / `replies_to` / `references`）以外**の関連付けを運用者/エージェントが手動で作成・削除できる write tool を追加する。

1. **`link.add`（write / HITL）。** 2 エンティティ間に手動 link を作成する。`LinkAdded` event を append → `links` projection に relation `manual_link` で反映。`readOnlyHint: false`（auto-apply なし、[ADR-0004](0004-mcp-agent-boundary-and-hitl.md)）。
2. **`link.remove`（write / HITL）。** 手動 link を `linkId` 指定で削除する。`LinkRemoved` event を append → 該当行を削除。event log は add/remove ペアを保持し**監査可能**。
3. **手動 link は安定 `link_id` を持つ。** reducer 由来エッジは端点のみで keyed（`link_id` は NULL）だが、手動 link は有向な端点ペア由来の content-derived id（`src/propose/id.ts` の `manualLinkId`）を持つ。これにより (a) `link.remove` が id で対象を特定でき、(b) replay 決定性（add→remove は行なし、add のみは行復元）を担保する。`links` テーブルに nullable `link_id` 列を追加（projection 拡張のみ、再 ingest 不要）。
4. **不変条件の維持。** event-sourced（[ADR-0002](0002-event-sourced-architecture.md)）: `LinkAdded` / `LinkRemoved` を discriminated union に追加し、reducer で畳む。idempotent（同一 link の再 add は no-op、replay で同値復元）。自己ループ・存在しない link の remove は tool 境界で拒否（tool error、silent skip しない）。
5. **read 経路との連携。** `graph.related` の neighbor に `linkId`（手動 link のみ）を付与し、削除対象の id を発見できるようにする。reducer 由来エッジは従来どおり `linkId` を持たない。
6. **本追補のスコープ外。** task↔decision 等の**自動**エッジ拡充は引き続き reducer 追補（別 Issue）。本追補は**手動 link の CRUD**に限定する。

## 追補（#97）: `graph.expand` の `direction`（[ADR-0020](0020-multi-actor-coordination-scope.md)）

`graph.expand` に `direction: "out" | "in" | "both"`（既定 `both` = 後方互換）を追加した。各 hop の隣接取得（`listLinks`）を direction で絞ることで、後方限定 provenance トレース（opshub `graph trace` 相当 = 「この成果物は何に由来するか」）を `in` で表現する。`out` は下流 consumer 展開。新ツールは増やさず既存 `graph.expand` の 1 パラメータ追加で実現する（ADR-0020 §決定 3）。cycle guard / edge dedup は direction 適用後も維持する。
