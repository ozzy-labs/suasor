# 0006. ML delegation (no heavy in-process ML)

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor は AI 秘書だが、**ML を自前で計算するか / 外に委譲するか**は言語選定（[ADR-0001](0001-typescript-bun-stack.md)）の上流にある重要判断。Suasor の差別化は「統合・記憶・HITL」であって ML の品質そのものではない。ML は Suasor にとって commodity な部品。

## Decision

**ML 計算は委譲する。重い ML をプロセス内で実行しない**（不変条件）:

- **LLM 生成** → API（Anthropic / OpenAI）or ローカル Ollama
- **embedding** → ローカルサイドカー（Ollama `/api/embed` 等）or API（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)）
- **OCR / 音声書き起こし** → ローカル binary サイドカー（Tesseract / whisper.cpp 等）
- `src/` に **モデル実体を持つディレクトリを作らない**。`src/llm` / `src/retrieval` の embedding は**外部への薄いクライアント**

例外: **小さく言語中立な in-process binding**（形態素解析の Lindera 等、ONNX reranker 等）は、**warm 文脈（常駐 MCP server）or 極小**で、target 言語に binding がある場合に限り許容。

判断ルール: ML は原則委譲。in-process にするのは「小さい × warm 文脈 or 極小 × 言語中立 binding あり × 密結合/決定性が本当に要る」が全て揃う時だけ。重い生成・知覚は規模で問答無用に委譲。

## Consequences

### Positive
- 言語が ML に縛られない（[ADR-0001](0001-typescript-bun-stack.md) の TS が成立）
- 配布が軽い（重いモデルを同梱しない、[ADR-0010](0010-distribution.md)）。CLI の cold start も軽い
- モデル更新に追従しやすい（サイドカーのモデルを差し替えるだけ）

### Negative / Trade-offs
- embedding 等でローカル model server（Ollama）への運用依存が出る
- in-process で作り込む高度な ML パイプラインはできない（Suasor の moat ではないため許容）

## Alternatives Considered
- 重い in-process ML（torch 相当を自前実行） → 却下。Suasor の moat でないのに配布痛・言語固定・cold start を抱える。ML 品質が製品そのものになった時のみ再考
