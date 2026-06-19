# 0022. Person identity resolution（author handle の同定と HITL merge/split）

- Status: Proposed
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Related: [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP+HITL）, [ADR-0002](0002-event-sourced-architecture.md)（event-sourced）, [ADR-0007](0007-connector-contract.md)（connector author）, [ADR-0012](0012-slack-demand-digest.md)（self_user_id）
- Tracks: #92 / epic #83

## Context

opshub には person サブシステムがあった: connector の author handle（Slack `U…`、GitHub login、メールアドレス等）を person に解決し、operator 主導の `person merge`/`person split` で identity 重複を統合・分離する（`person list/merge/split`）。suasor には無く、**同一人物が connector 横断でバラバラの author として現れる**（例: Slack の自分・GitHub の自分・メールの自分が別物）。

これは demand signal（ADR-0012 が `self_user_id` を手動設定で 1 つだけ扱う）や commitment（ADR-0021、owed-to/by-person）の精度に直結する。port するか、する場合の identity モデルを決める。

## Decision

**port する。軽量な person projection + HITL merge/split として実装**（推奨）:

1. **person は projection（event 由来）** — connector author を取り込む際に handle→person の対応を `persons` / `person_identities` projection に投影（ADR-0002/0007）。初期は **1 handle = 1 person**（自動同定はしない）から始め、誤統合リスクを避ける。
2. **同定は HITL（自動 fuzzy 同定はしない）** — 自動マージは誤統合（別人を同一視）が高コスト。`person.merge`（2 person を 1 つに）/`person.split`（1 identity を別 person に分離）を **MCP write tool（HITL・ADR-0004）** として提供し、operator/agent の明示操作でのみ統合する。merge/split は event で記録し監査可能（reversible）。
3. **read = MCP read tool `person.list`** — person と紐づく handle/source を列挙。`readOnlyHint: true`。
4. **self の扱い** — 現状 `self_user_id`（ADR-0012）の手動単一設定を、将来「self とマークした person」へ一般化できる余地を残す（本 ADR では破壊しない。別 Issue）。

## Consequences

### Positive

- connector 横断で同一人物を束ねられ、demand/commitment/graph の「人」軸の精度が上がる
- 自動同定を避け HITL に倒すことで誤統合を防ぐ（merge/split は reversible）
- read/write を MCP に寄せ CLI を太らせない

### Negative / Trade-offs

- 初期は 1 handle = 1 person のため、手動 merge をするまで重複が見える（安全側の割り切り）
- person projection 追加で event スキーマ/投影が増える

## Alternatives Considered

- **自動 fuzzy 同定（名前/メール一致でマージ）** — 却下。誤統合（同名別人）のリスクが高く、event-sourced で巻き戻しコストも大きい。まず HITL、自動化は将来データが溜まってから別 ADR で。
- **person を持たず author handle のまま運用** — 却下。横断の「人」軸が永久に分断され、demand/commitment の価値が頭打ちになる。
- **opshub の CLI `person merge/split` を移植** — 却下。write 系は MCP HITL に置く方針（ADR-0004）。
