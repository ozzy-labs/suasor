# 0003. Local-first and external-content minimization

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor が扱うのは個人の業務文脈（チャット・メール・カレンダー・ドキュメント・コード・Web）であり、機密性が高い。「あなたの記憶」を名乗る以上、データの置き場所と外部送信の扱いが製品の信頼の核になる。

## Decision

**ローカルファースト**を貫く:

1. 取り込んだ本文・メタデータは**手元（ユーザーのマシン）のプライベートストアに保持**する
2. connector は **read 専用**でソースに書き戻さない（[ADR-0007](0007-connector-contract.md)）
3. **勝手に外部送信しない** — 送信・書き込みは人の承認を要する（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md)）
4. 外部に出すのは、ユーザー/エージェントが明示的に選んだ最小限のみ（要約に必要な範囲を LLM に渡す等も、可能ならローカルサイドカー経由 = [ADR-0006](0006-ml-delegation.md)）

## Consequences

### Positive
- privacy が差別化の核になる（「すべてを覚え、何も勝手に出さない」）
- ネット非依存で動く範囲が広い（FTS 検索・ローカル embedding 等）

### Negative / Trade-offs
- ローカルストレージ・OS keychain 等、環境依存の取り回しが要る
- フロンティア LLM 等、外部 API を使う機能では「何を送るか」を明示設計する必要

## Alternatives Considered
- クラウド集約型（SaaS にデータを集める） → 却下。機密業務文脈の秘書という性質に反する
