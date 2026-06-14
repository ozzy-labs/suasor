# 0008. Assistant skills

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

ユーザーは「今日のまとめ」「次にやること」「この資料からタスク抽出」のような自然文で Suasor に依頼する。これらをエージェントホスト上の **skill**（自然文トリガ）として提供し、Suasor の MCP tool を組み合わせて応答させたい。

## Decision

Suasor は **アシスタント skill 群（初期 15 想定）** を提供する:

- **SSOT は `docs/skills/<name>/SKILL.md`**。発火条件は自然文（skill description）で表現
- 配信は **Suasor パッケージ同梱 + `suasor skills install`**（`.claude/skills/` / `.agents/skills/` に展開）。in-repo では dogfood として commit
- skill は read 系（personal-brief / next-actions / find-document / research 等）と **HITL write 系**（reply-draft / inbox-triage / source-extract / meeting-followup 等）に分かれ、write は [ADR-0004](0004-mcp-agent-boundary-and-hitl.md) の HITL 境界に従う（auto-apply なし）
- エコシステム共通 dev skill（drive / lint / commit 等）は `@ozzylabs/skills` 経由で別供給（名前空間 disjoint）

具体的な 15 skill の責務マップ・MCP tool 依存・pair 構造は `docs/design/` と各 `SKILL.md` で定義する。

## Consequences

### Positive
- 自然文で Suasor を使える（エージェントが裏で MCP tool を叩く）
- skill が Suasor と一緒に配布・バージョン管理される

### Negative / Trade-offs
- skill SSOT と配布先の同期（install/再生成）の運用が要る

## Alternatives Considered
- skill を外部 preset 配信に一本化 → 却下。Suasor 固有 skill は Suasor と一体で配布・バージョン管理する方が整合
