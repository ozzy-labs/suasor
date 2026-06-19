# 0017. `brief` MCP tool — period bundle for host summarization

- Status: Accepted
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Related: [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP read 境界）, [ADR-0006](0006-ml-delegation.md)（ML 委譲：in-process で重い ML を持たない）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（FTS-first）
- Prior art: opshub `brief`（LLM 生成 briefing + `BriefingGenerated` event）

## Context

`mcp-surface.md` は `brief`（期間サマリ）を「後続 Issue」として未実装のまま残している。一方、同梱 skill の **`personal-brief` / `external-brief` は `brief` を第一参照**として記述している（「`brief`（LLM 要約）または recall.search / task.list / … を順に叩いて要約」）。現状は後段の read tool 合成にフォールバックして動くが、host が毎回複数ツールを手で叩いて期間素材を組み立てる必要がある。

opshub は `brief` を **LLM が briefing を生成して `BriefingGenerated` event で永続**する設計だが、suasor は [ADR-0006](0006-ml-delegation.md)（in-process で重い ML を持たない）+ [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（LLM 推論ループは外部ホスト側）の方針なので、**同じ「tool 内 LLM 生成」は採らない**。

## Decision

1. **`brief` は read-only の「期間バンドル」tool。** 指定期間（`since` / `until`、既定は直近 24h）の主要 entity を 1 回の呼び出しで構造化して返す: 動いた `tasks`（updated 窓）/ 記録された `decisions`（recorded 窓）/ 未処理 `inbox`（open）/ 新規 `sources`（observed 窓）/ `slack.demand`（observed 窓、[ADR-0012](0012-slack-demand-digest.md)）。**要約文そのものは生成しない** — host LLM が返却バンドルから要約を組み立てる（ADR-0006/0004）。
2. **既存 query の合成で実装する（新規 projection なし）。** `listSources` / `listTasks` / `listDecisions` / `listInbox` / `listSlackDemand` を期間フィルタ付きで束ねる薄い service（`buildBrief`）+ `brief` tool。`readOnlyHint: true`。
3. **persist しない。** `BriefingGenerated` 相当の event は作らない（host が要約、保存はしない）。provenance が要るケースは別途 graph（[ADR-0018](0018-knowledge-graph-traversal.md)）で辿る。
4. **戻り値**: `{ "window": {since, until}, "tasks": [...], "decisions": [...], "inbox": [...], "sources": [...], "demand": [...] }`。各セクションは既存 read tool と同じ row 形。`limit` で各セクション上限。

## Consequences

### Positive

- `personal-brief` / `external-brief` skill が 1 ツールで期間素材を取得でき、host のラウンドトリップが減る。
- in-process LLM なし・persist なしで ADR-0006/0004 を崩さない。read tool のみ（auto-approve 可）。

### Negative / Trade-offs

- 「要約」は host 依存（tool は素材まで）。opshub の `BriefingGenerated` provenance は持たない（必要なら別 ADR）。
- セクションが増えると payload が大きくなる → `limit` と期間で制御。

## Alternatives Considered

- **tool 内で LLM 要約 + 永続（opshub 方式）** — 却下。ADR-0006（in-process ML なし）/ ADR-0004（推論は host）に反する。
- **skill の read tool 合成のまま（tool を作らない）** — 可。だが host のラウンドトリップが多く、`brief` が skill の第一参照である以上、薄い束ね tool の価値はある。
- **期間サマリを embedding で要約** — 却下。要約は生成タスクで FTS/embedding の領分でない。
