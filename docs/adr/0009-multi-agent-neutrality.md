# 0009. Multi-agent neutrality

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor の利用者は特定の 1 エージェントホストに限らない。Claude Code / Codex CLI / Gemini CLI / GitHub Copilot CLI を横断して同じ体験を提供したい。

## Decision

**マルチエージェント中立**を保つ。4 CLI をサポートする:

- 共通指示の SSOT は **`AGENTS.md`**（Codex / Gemini / Copilot が参照）。Claude Code は `CLAUDE.md` を併読
- アダプタ: Claude Code = `CLAUDE.md` + `.claude/`、Gemini = `.gemini/settings.json → AGENTS.md`、Codex / Copilot = `AGENTS.md` + `.agents/skills/`、Copilot = `.github/copilot-instructions.md`
- 機能面はすべて **MCP 経由**（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md)）なので、どのホストからも同じ tool surface を叩ける
- skill（[ADR-0008](0008-assistant-skills.md)）は `.claude/skills/` と `.agents/skills/` の両方に展開

## Consequences

### Positive
- 特定ホストに lock-in されない
- MCP 境界に揃えることで surface の重複実装を避けられる

### Negative / Trade-offs
- 4 ホスト分のアダプタファイルを維持する手間（commons が大半を肩代わり）

## Alternatives Considered
- 単一ホスト（Claude Code）専用 → 却下。利用者の選択肢を狭め、エコシステム中立性を失う
