# 0004. MCP as the agent boundary, with HITL writes

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor の主たる利用者は人間ではなく **AI エージェント（Claude Code / Codex / Claude Desktop 等）**。エージェントが Suasor の記憶・機能をどう叩くか、そして「勝手に行動しない」をどう担保するかを定める必要がある。

## Decision

**MCP (Model Context Protocol) をエージェント境界**にする。Suasor の機能は MCP tool として公開し、tool を **read / write の 2 カテゴリ**に分ける:

- **read tool**（検索・要約・一覧・recall 等）= 副作用なし、エージェント自律 OK
- **write tool**（返信・タスク・決定の提案の適用、外部送信 等）= **HITL（Human-in-the-loop）**。提案を生成するだけで、**人の承認なしに適用・送信しない**。auto-apply 経路を持たない

tool 入力スキーマは Zod で定義する。CLI からも同じサービス層を叩く。

## Consequences

### Positive

- エージェントは安全に read を自律実行でき、危険な write は人がゲートする
- 「提案 → 承認 → 適用」が一貫した HITL ループになる（[ADR-0008](0008-assistant-skills.md) の skill 群もこの境界に乗る）

### Negative / Trade-offs

- 完全自律の「実行まで」体験は提供しない（意図的な制約）

## Alternatives Considered

- エージェントに write を自律させる（auto-apply） → 却下。local-first/privacy/信頼の姿勢（[ADR-0003](0003-local-first-and-content-minimization.md)）に反する
- 独自 RPC / REST 境界 → 却下。消費者は MCP エージェントなので MCP が自然
