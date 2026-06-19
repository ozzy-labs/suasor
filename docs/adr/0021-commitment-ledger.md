# 0021. Commitment ledger（約束/コミットメントの抽出と HITL 管理）

- Status: Proposed
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Related: [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP+HITL）, [ADR-0006](0006-ml-delegation.md)（ML 委譲）, [ADR-0012](0012-slack-demand-digest.md)（demand signal）, [ADR-0002](0002-event-sourced-architecture.md)（event-sourced）
- Tracks: #91 / epic #83

## Context

opshub には commitment サブシステムがあった: 取り込み済み source から LLM で「約束/コミットメント」（"X までに Y する" の類）を抽出し、`open / resolved / dismissed` を operator HITL で管理する台帳（`commitment scan/list/resolve/dismiss/reopen`）。suasor には**概念ごと存在しない**。

これは「読むべき/対応すべき」signal という点で **demand digest（ADR-0012、Slack mention/DM）と同系統**だが、ソース横断で LLM 抽出する点が異なる。port するか、するならどう suasor のアーキにマップするかを決める。

## Decision

**port する。ただし opshub の `commitment scan`（専用 LLM 経路）を新設せず、既存の propose パイプライン（ADR-0006 ML 委譲・ADR-0004 HITL）に寄せる**（推奨）:

1. **抽出 = propose の候補種別として表現** — `propose.generate` が LLM 委譲で候補を出す既存経路に `commitment` 種別を追加する。LLM 呼び出し口を二重化しない（ADR-0006 の委譲境界を 1 本に保つ）。
2. **commitment は event + projection** — 確定した commitment を event（`CommitmentOpened` 等）で append し、`commitments` projection に投影（ADR-0002）。direction（owed-by-me / owed-to-me）・期日・関連 person/source を保持。
3. **read = MCP read tool `commitment.list`** — open/resolved/dismissed・direction・person でフィルタ。`readOnlyHint: true`。`brief`/`next-actions` skill が demand と並べて取り込める。
4. **状態遷移 = MCP write tool（HITL）** — `commitment.resolve` / `commitment.dismiss` / `commitment.reopen`。auto-apply なし（ADR-0004）。

## Consequences

### Positive

- 「対応すべき」signal が demand（Slack）+ commitment（横断 LLM 抽出）で揃い、assistant skill の priority が厚くなる
- LLM 呼び出しを propose 経路に集約し、ML 委譲境界（ADR-0006）を 1 本に保てる
- read/write を MCP に寄せ、CLI 表面を太らせない（ADR-0004）

### Negative / Trade-offs

- propose スキーマに種別が増え、候補レンダリング/apply 分岐が複雑化
- LLM 抽出の精度依存（誤検出は dismiss で HITL 吸収するが運用コスト）

## Alternatives Considered

- **opshub のまま `commitment scan` 専用 CLI を port** — 却下。LLM 呼び出し口が propose と二重化し、ADR-0006 の委譲境界が割れる。CLI に write 系を持ち込むのも ADR-0004 に反する。
- **commitment を持たず demand に吸収** — 却下。demand は「未読/未処理の受信」、commitment は「能動的な約束」で粒度と状態機械が異なる（resolve/dismiss/reopen のライフサイクルが必要）。
- **後回し（drop）** — 非推奨。デイリー運用の「やるべきこと」可視化の中核で、parity 上の価値が高い。
