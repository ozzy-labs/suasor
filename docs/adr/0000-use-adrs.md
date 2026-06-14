# 0000. Use ADRs

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor はローカルファーストの AI 秘書として、event sourcing・ローカル優先・MCP 境界・ML 委譲など、後から覆すと高コストな設計判断を多く含む。これらを「なぜそう決めたか」を文脈・代替案・トレードオフとともに残さないと、将来の自分や他のエージェントが理由を見失い、決定を場当たり的に揺り戻すリスクがある。

## Decision

重要な設計判断を `docs/adr/` に Michael Nygard 形式の ADR として記録する。spec-driven 開発（要件 → ADR → 設計 → 実装）の中で、ADR は「決定」レイヤを担う。

## Consequences

### Positive
- 判断の根拠が文脈付きで残り、再議論のコストが下がる
- 実装・レビュー時に「不変条件」を ADR 参照で確認できる

### Negative / Trade-offs
- ADR を書く・保守するコストがかかる（重要判断に限定して緩和）

## Alternatives Considered
- 決定を README やコードコメントに散らす → 却下。文脈・代替案が残らず、再議論を招く
