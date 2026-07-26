# 0006. ML delegation (no heavy in-process ML)

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor は AI 秘書だが、**ML を自前で計算するか / 外に委譲するか**は言語選定（[ADR-0001](0001-typescript-bun-stack.md)）の上流にある重要判断。Suasor の差別化は「統合・記憶・HITL」であって ML の品質そのものではない。ML は Suasor にとって commodity な部品。

## Decision

**ML 計算は委譲する。重い ML をプロセス内で実行しない**（不変条件）:

- **LLM 生成** → **Suasor は行わない。host（MCP クライアント）が LLM である**（決定 4）
- **embedding** → ローカルサイドカー（Ollama `/api/embed` 等）or API（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)）
- **OCR / 音声書き起こし** → ローカル binary サイドカー（Tesseract / whisper.cpp 等）
- `src/` に **モデル実体を持つディレクトリを作らない**。`src/llm` / `src/retrieval` の embedding は**外部への薄いクライアント**

例外: **小さく言語中立な in-process binding**（形態素解析の Lindera 等、ONNX reranker 等）は、**warm 文脈（常駐 MCP server）or 極小**で、target 言語に binding がある場合に限り許容。

判断ルール: ML は原則委譲。in-process にするのは「小さい × warm 文脈 or 極小 × 言語中立 binding あり × 密結合/決定性が本当に要る」が全て揃う時だけ。重い生成・知覚は規模で問答無用に委譲。

### 決定 4: 生成は「サイドカーに委譲する」のではなく「そもそも Suasor がやらない」（2026-07-26 追記）

本 ADR は当初、LLM 生成を embedding や OCR と**同じ形の委譲**（Suasor がサイドカー / API を呼ぶ）として書いていた。これは実装と食い違っていた — **Suasor はどこからも LLM を呼んでおらず**、要約が要る地点はすべて host に渡している:

| 地点 | 実際の振る舞い |
| --- | --- |
| `brief`（[ADR-0017](0017-brief-period-bundle.md)） | 期間の材料を**束ねるだけ**。要約は host |
| `digest`（[ADR-0040](0040-proactive-push-lane.md)） | 決定論的 scorer の上位 N を**render するだけ** |
| `propose.generate` | **host が作った内容**を HITL 候補に整形するだけ |

したがって正しい記述は「LLM をどこに委譲するか」ではなく **「LLM は host そのものであり、Suasor は生成しない」**（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md) の MCP 境界の裏返し）。embedding / extraction / OCR の委譲は従来どおりサイドカー形式で残る — これらは host が持たない能力だが、**生成は host が定義上持っている**。

**帰結**: `[llm]` config 節を廃止する（[#529](https://github.com/ozzy-labs/suasor/issues/529)）。`anthropic` / `openai` / `ollama` という選択肢を提示しながら**どのコードも読まない**面であり、`suasor init` が全 config に書き込んでいた。既存 config は壊さず、節が残っていれば削除を促す WARN を出す。

**再考の条件**: 「host の付かないレーンで文章を生成したい」が実需になった時（現状 [ADR-0040](0040-proactive-push-lane.md) の cron digest が唯一の候補だが、top-N は元々短く各行が行動可能な根拠を持つため、散文化はスキャン性を下げる損な再レンダリングになる。加えて無人で本文を外部 API に送るのは [ADR-0003](0003-local-first-and-content-minimization.md) と正面衝突する）。その時は**そのレーン専用の設定**として設計する — 汎用の `[llm]` 節を先回りで置かない。

## Consequences

### Positive

- 言語が ML に縛られない（[ADR-0001](0001-typescript-bun-stack.md) の TS が成立）
- 配布が軽い（重いモデルを同梱しない、[ADR-0010](0010-distribution.md)）。CLI の cold start も軽い
- モデル更新に追従しやすい（サイドカーのモデルを差し替えるだけ）

### Negative / Trade-offs

- embedding 等でローカル model server（Ollama）への運用依存が出る
- **host が付かない限り生成は起きない**（決定 4）。cron の digest は構造化バンドルのままで、散文サマリは出ない
- in-process で作り込む高度な ML パイプラインはできない（Suasor の moat ではないため許容）

## Alternatives Considered

- 重い in-process ML（torch 相当を自前実行） → 却下。Suasor の moat でないのに配布痛・言語固定・cold start を抱える。ML 品質が製品そのものになった時のみ再考
