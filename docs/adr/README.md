# Architecture Decision Records

Suasor の重要な設計判断を ADR (Architecture Decision Record) として記録する。

## フォーマット

[Michael Nygard 形式](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)（簡易版）。各 ADR は次の見出しを持つ:

```markdown
# NNNN. Title

- Status: Proposed | Accepted | Deprecated | Superseded by ADR-NNNN
- Date: YYYY-MM-DD
- Deciders: <人 / role>

## Context
## Decision
## Consequences
### Positive
### Negative / Trade-offs
## Alternatives Considered
```

## 何を ADR にするか

- 言語 / スタックの選定
- アーキテクチャ全体に影響する判断（event sourcing、agent boundary、ML 委譲 など）
- 後から覆すと高コストになる判断
- 直感に反するため理由を残す必要がある判断

容易に覆せる実装詳細（個別ライブラリ選定など）は ADR にしない。

## ファイル命名

```text
NNNN-kebab-case-title.md
```

## Index

| ADR | Title |
|---|---|
| 0000 | Use ADRs |
| 0001 | TypeScript / Bun stack |
| 0002 | Event-sourced architecture |
| 0003 | Local-first and external-content minimization |
| 0004 | MCP as the agent boundary, with HITL writes |
| 0005 | FTS-first retrieval, embedding as an optional sidecar |
| 0006 | ML delegation (no heavy in-process ML) |
| 0007 | Connector contract |
| 0008 | Assistant skills |
| 0009 | Multi-agent neutrality |
| 0010 | Distribution |
| 0011 | Slack operational verbs (auth test / conversations) and readiness |
| 0012 | Slack demand digest (mention/DM signal) + `slack.demand.list` |
| 0013 | Slack engagement axis (search.messages / last_self_post, User Token) |
| 0014 | Slack multi-workspace (`[connectors.slack.workspaces.<alias>]`) |
| 0015 | Slack thread replies ingestion (`conversations.replies`) |
| 0016 | Slack sync date floor + cursor reset/backfill recovery verbs |
| 0017 | `brief` MCP tool — period bundle for host summarization |
| 0018 | Knowledge graph traversal — `graph.related` / `graph.expand` |
| 0019 | Slack fetch-path rate-limit retry (Retry-After-honoured) |
| 0020 | Multi-actor coordination scope (session/handoff/lock/agent-run/workspace) + graph.trace |
| 0021 | Commitment ledger (extraction + HITL lifecycle) |
| 0022 | Person identity resolution (handle dedup, HITL merge/split) |
| 0023 | Local-filesystem connectors (generic `local`, box-drive/onedrive-drive) |
| 0024 | Document extraction sidecar (Office/PDF → text; local-first, API staged) |
| 0025 | Local draft export (draft.export; no egress, sandbox, body-less event) |
