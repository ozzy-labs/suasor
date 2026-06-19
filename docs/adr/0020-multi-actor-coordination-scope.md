# 0020. Multi-actor coordination scope（session/handoff/lock/agent-run/workspace）+ graph.trace

- Status: Proposed
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Related: [ADR-0003](0003-local-first-and-content-minimization.md)（local-first）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP 境界）, [ADR-0009](0009-multi-agent-neutrality.md)（マルチエージェント中立）, [ADR-0018](0018-knowledge-graph-traversal.md)（graph traversal）
- Tracks: #95 / epic #83

## Context

opshub→suasor の CLI/機能パリティ総点検（epic #83）で、opshub にあった次の coordination 系プリミティブが suasor に**概念ごと不在**と判明した:

| opshub | 役割 | suasor |
|---|---|---|
| `session start/list/end` | work session のライフサイクル（actor の作業単位） | 無 |
| `handoff open/list/close` | actor 間の引き継ぎ | 無 |
| `lock acquire/list/release` | scope への分散ロック | 無 |
| `agent run begin/end` | agent 実行を session に紐付け | 無 |
| `workspace generate/ingest` | tasks projection ⇄ markdown ミラー | 無 |
| `graph trace` | 後方 provenance の N-hop トレース | 無（`graph.related`/`graph.expand` のみ） |

これらが「意図的 drop」か「デグレ」か ADR で明文化されていないため判断できない。本 ADR で **port / drop** を確定する。

## Decision

### 1. session / handoff / lock / agent-run は **正式に drop**（推奨）

suasor は **single-user / local-first**（ADR-0003）であり、エージェントホスト（Claude Code / Codex / Gemini / Copilot）が「セッション」「実行」を既に管理する（ADR-0009）。opshub の coordination モデルは**複数の人間/プロセスが 1 つの共有 store を同時編集する**前提の重量級プリミティブで、suasor の前提では:

- **session / agent-run** = ホスト側の会話/実行がその役割を担う。suasor が二重に session 台帳を持つと SSOT が割れる。
- **lock** = 単一ユーザ・ローカル SQLite では分散ロックは過剰。書き込みは MCP write tool の HITL（ADR-0004）で直列化され、競合は実質発生しない。
- **handoff** = actor 間引き継ぎは multi-actor 前提。single-user では不要。

→ event/aggregate として**実装しない**ことを明文化する。将来マルチエージェント協調（ADR-0009 の射程拡大）で**軽量な**実行メタが必要になった場合は、本 ADR を superseded する別 ADR で再検討する（YAGNI を優先）。

### 2. workspace（markdown ミラー）は **drop**（推奨）

opshub の `workspace generate`（tasks→markdown）/`ingest`（markdown→event）は、SQLite/MCP を持たない時代の human-readable ミラー。suasor は MCP read tool（`task.list`/`brief` 等）が human/agent 双方の参照面を提供するため、markdown ミラーは**冗長**。将来「ファイルで編集したい」需要が出れば縮小 port を別 Issue で検討。

### 3. graph.trace は **port**（推奨・小規模）

`graph.related`（1-hop）/`graph.expand`（双方向 N-hop）はあるが、**「この成果物は何に由来するか」を遡る後方限定トレース**は欠けている。これは provenance の中核ユースケースで価値が高い。**`graph.expand` に `direction: "in" | "out" | "both"`（既定 both）パラメータを追加**して trace を表現する（新ツールを増やさず ADR-0018 の自然な拡張）。incoming のみ指定で opshub `graph trace` 相当になる。

## Consequences

### Positive

- coordination 系を持たない判断を明文化し、「デグレではなく設計」を確定（将来の混乱を防ぐ）
- single-user/local-first の単純さを保つ（aggregate 数を増やさない）
- graph.trace は既存ツールの 1 パラメータ追加で実現（最小コスト・後方互換）

### Negative / Trade-offs

- 将来マルチエージェント協調を本格化する場合、coordination プリミティブを再設計する必要（その時点の要件で作る方が良い、という賭け）
- markdown で編集したい層には workspace の不在が不便（MCP 経由に誘導）

## Alternatives Considered

- **全部 port** — 却下。single-user 前提で重量級 coordination を持ち込むと SSOT 重複・複雑性増。ホストが既に担う領域と衝突。
- **lock だけ軽量 port**（write 競合対策） — 却下。MCP write の HITL 直列化で競合は実質回避でき、ローカル SQLite の WAL で十分。
- **graph.trace を独立ツール新設** — 却下。`graph.expand` の direction 拡張で表現でき、ツール表面を増やさない方が MCP host に優しい。
