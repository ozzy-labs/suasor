# Non-Functional Requirements

## Privacy / Local-first

- **NFR-PRV-1 (MUST)** 取り込んだ本文・メタデータは手元のプライベートストアに保持。勝手に外部送信しない（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）
- **NFR-PRV-2 (MUST)** 送信・書き込みは人の承認を要する（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）
- **NFR-PRV-3 (SHOULD)** embedding/LLM はローカルサイドカー（Ollama 等）で完結できる（egress なし）（[ADR-0006](../adr/0006-ml-delegation.md)）
- **NFR-PRV-4 (MUST)** secrets（API トークン等）は OS keychain に格納（env override 可）

## ML / 依存

- **NFR-ML-1 (MUST)** 重い ML をプロセス内で実行しない（委譲）（[ADR-0006](../adr/0006-ml-delegation.md)）
- **NFR-DEP-1 (SHOULD)** core 既定インストールは軽量（重い ML 依存を含まない）

## Performance

- **NFR-PRF-1 (SHOULD)** CLI cold start は軽量（lazy import / 重い依存を top-level で読まない）
- **NFR-PRF-2 (SHOULD)** FTS 検索は単一ユーザー規模で対話的応答（〜数百ms）

## Portability / Distribution

- **NFR-DST-1 (MUST)** npm / Bun 単一バイナリ / Docker で配布可能（[ADR-0010](../adr/0010-distribution.md)）
- **NFR-DST-2 (SHOULD)** air-gap 環境で（単一バイナリ + ローカルサイドカーで）動作可能

## Quality

- **NFR-QLT-1 (MUST)** TypeScript strict、Biome lint/format、型チェック + テストが CI で通る
- **NFR-QLT-2 (MUST)** 全変更は Issue + PR（squash / main 直 push 禁止）

## Internationalization

- **NFR-I18N-1 (SHOULD)** 日本語・英語混在の業務文脈を扱える（FTS の日本語対応 / 多言語 embedding）
