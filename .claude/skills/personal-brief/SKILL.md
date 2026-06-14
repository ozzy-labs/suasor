---
name: personal-brief
description: 「今日のまとめ」「今週どうなってる」「最近どう」「自分の状況」「先週の振り返り」と聞かれたら、指定期間（既定は直近 24h）の主要な動きを自分向けにまとめる。Suasor MCP の brief / recall.search / task.list / decision.list / inbox.list を読み取り系で組み合わせて要約する。
---

# personal-brief

自分向けの状況サマリ。「最近どうなってる」を read-only で組み立てる。pair: 外向きは [external-brief](../external-brief/SKILL.md)。

## いつ発火するか

- 「今日のまとめ」「今週どうなってる」「今月の動き」「先週の状況」「先月の振り返り」
- 「最近どうなってる」「状況教えて」「自分の状況」

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。副作用なし・エージェント自律 OK。

1. 期間を決める。明示がなければ直近 24h。ISO 8601（offset 付き）の `since` を作る
2. `brief` で期間サマリを取る（LLM 要約。委譲先で生成、[ADR-0006](../../adr/0006-ml-delegation.md)）
3. 補強が要れば次を時間フィルタ付きで叩く（下限 inclusive `*After` / 上限 exclusive `*Before`）:
   - `task.list`（`updatedAfter=since`）— 動いた task
   - `decision.list`（`recordedAfter=since`）— 記録された決定
   - `inbox.list`（`state=open`）— 未処理シグナル
   - `recall.search` — トピックの関連 context（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
4. 集めた結果をホスト LLM が「主要な動き」として要約して返す

## 制約

- read-only。persist しない（イベントを書かない）
- LLM 推論ループは外部ホスト（Claude Code 等）側。本 skill は手順書のみで実処理を持たない
- 時間窓は各 projection の自然な timestamp 列が対象（task/inbox=`updated_at`、decision=`recorded_at`）
