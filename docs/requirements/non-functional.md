# Non-Functional Requirements

## Privacy / Local-first

- **NFR-PRV-1 (MUST)** 取り込んだ本文・メタデータは手元のプライベートストアに保持。勝手に外部送信しない（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）
- **NFR-PRV-2 (MUST)** 送信・書き込みは人の承認を要する（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）
- **NFR-PRV-3 (MUST)** **Suasor 自身は本文を LLM に送らない。** 生成は host（MCP クライアント）が行い（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) / [ADR-0006](../adr/0006-ml-delegation.md) 決定 4）、Suasor から本文が出る経路は embedding / extraction サイドカーに限られる。いずれも既定 loopback で、非 loopback は `allowRemote` の明示 opt-in が無ければ loader が拒否する（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）
  - 旧版は「embedding/LLM はローカルサイドカーで完結できる（SHOULD）」だった。embedding 側は ollama で真だが、**LLM 側は Suasor から保証しようがない** — LLM は host であり、host の egress は Suasor の管轄外である。約束できない範囲を落とし、代わりに**検証可能で、より強い**性質に差し替えた（[#529](https://github.com/ozzy-labs/suasor/issues/529)）
  - embedding をローカル完結させたい場合は `[embedding].backend = "ollama"`（既定 loopback）を使う
- **NFR-PRV-4 (MUST)** secrets（API トークン等）は OS keychain に格納（env override 可）
- **NFR-PRV-5 (MUST)** ストア（DB・`-wal` / `-shm`・config・バックアップ）は**所有者のみ読み書き可**（`0600` / ディレクトリ `0700`）。**同一マシンの他ユーザーから読めてはならない**（[ADR-0048](../adr/0048-at-rest-protection.md) 決定 2）
- **NFR-PRV-6 (SHOULD)** 盗難・紛失したディスクに対する保護は **OS のフルディスク暗号化**に委ねる（Suasor はアプリ内暗号化を行わない）。前提を検証しないまま置かないため、`suasor doctor` が判定可能な OS では状態を報告し、判定できない場合は **`unknown` と明示**する（[ADR-0048](../adr/0048-at-rest-protection.md) 決定 3）
  - **守られない範囲を明示する**: FDE 無効のディスク盗難、およびユーザー自身のアカウントを奪取した攻撃者（同一 uid で動く以上、いかなるアプリ内暗号化でも鍵に到達される）。脅威モデル全体は [ADR-0048](../adr/0048-at-rest-protection.md) 決定 1 の表を参照

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
