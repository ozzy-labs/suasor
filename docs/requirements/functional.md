# Functional Requirements

ID は `FR-<area>-<n>`。MUST/SHOULD/MAY は RFC 2119。

## Ingest（取り込み）

- **FR-ING-1 (MUST)** connector がソース（チャット/メール/カレンダー/ドキュメント/コード/Web）から **read 専用**で取り込む（[ADR-0007](../adr/0007-connector-contract.md)）
- **FR-ING-2 (MUST)** 取り込みは event として append され、本文はローカル projection に保持される（[ADR-0002](../adr/0002-event-sourced-architecture.md) / [ADR-0003](../adr/0003-local-first-and-content-minimization.md)）
- **FR-ING-3 (MUST)** delta API があれば cursor、なければ本文 fingerprint で差分検知
- **FR-ING-4 (SHOULD)** `suasor <connector> sync` CLI で取り込みを実行できる

## Retrieve（検索・想起）

- **FR-RET-1 (MUST)** FTS5 による全文検索を提供（既定経路）（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
- **FR-RET-2 (SHOULD)** embedding 有効時、意味検索（recall）を提供。無効時は FTS に graceful 劣化
- **FR-RET-3 (MUST)** 検索・想起は MCP の **read tool** として公開（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）

## Advise / Propose（助言・提案）

- **FR-ADV-1 (MUST)** 要約（brief）・横断調査（research）等の read 系を提供
- **FR-PRO-1 (MUST)** 返信・タスク・決定の **候補を提案**する（generate）
- **FR-PRO-2 (MUST)** 提案の適用は **HITL**。人の承認なしに適用・送信しない（auto-apply なし）（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）

## Assistant skills

- **FR-SKL-1 (MUST)** 自然文トリガのアシスタント skill 群を提供（SSOT `docs/skills/`）（[ADR-0008](../adr/0008-assistant-skills.md)）
- **FR-SKL-2 (MUST)** `suasor skills install` で `.claude/skills/` `.agents/skills/` に展開

## Agent surface

- **FR-MCP-1 (MUST)** すべての機能を MCP tool（read / write）として公開（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）
- **FR-MCP-2 (MUST)** Claude Code / Codex / Gemini / Copilot から同一 surface を利用可能（[ADR-0009](../adr/0009-multi-agent-neutrality.md)）

## Maintenance

- **FR-MNT-1 (MUST)** `suasor projections rebuild` で event replay により projection を同値復元できる（[ADR-0002](../adr/0002-event-sourced-architecture.md)）
