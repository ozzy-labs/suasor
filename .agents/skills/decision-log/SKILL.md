---
name: decision-log
description: 「今月の決定」「直近の意思決定一覧」「[topic] の決定履歴」「最近どんな決定があった」「決定の変遷を追いたい」と頼まれたら、Suasor MCP の decision.list（期間 / topic 絞り）+ graph.related（各決定の背景 source / 先行決定）+ brief（統合要約）を読み取り系で組み合わせ、期間 / トピック横断の意思決定一覧と変遷を返す。read-only。
readOnly: true
category: decision
triggers:
  - 今月の決定
  - 直近の意思決定一覧
  - "[topic] の決定履歴"
  - 最近どんな決定があった
  - 決定の変遷を追いたい
pairs: []
mcp_tools_read:
  - decision.list
  - graph.related
  - brief
mcp_tools_write: []
---

# decision-log

期間 / トピックの意思決定を **横断一覧**し、変遷を把握する read skill。「いつ何を決めたか」を read-only で時系列に組み立てる（[ADR-0008](../../adr/0008-assistant-skills.md) の skill 設計）。**新 MCP tool は不要**で、既存 read tool の合成で実現する。pair の対ではないが、1 件の「なぜ」を深掘る [decision-rationale](../decision-rationale/SKILL.md) の横断版にあたる。

## いつ発火するか

- 「今月の決定」「直近の意思決定一覧」「最近どんな決定があった」
- 「[topic] の決定履歴」「決定の変遷を追いたい」

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。副作用なし・エージェント自律 OK。**専用 tool は追加しない**（既存合成、[ADR-0008](../../adr/0008-assistant-skills.md)）。

1. 対象期間 / トピックを決める。期間の明示があれば ISO 8601（offset 付き）の `recordedAfter` / `recordedBefore` に落とす。明示がなければ直近 1 か月程度を既定にする
2. `decision.list`（`recordedAfter` / `recordedBefore` で期間絞り）で対象決定を時系列に引く。各 decision は `title` / `rationale` / `recorded_at`。トピック指定がある場合はホスト側で `title` / `rationale` のキーワード一致で絞り込む
3. 各決定について `graph.related` で起点に、背景 source（根拠になったやりとり）/ 先行 decision（変遷の前段）へ `links` を辿り、変遷の関係を補強する（[data-model.md](../../design/data-model.md)）
4. `brief`（`since`=対象期間開始）で期間全体の主要な動きの LLM 要約を取り、決定群の文脈を補う（委譲先で生成、[ADR-0006](../../adr/0006-ml-delegation.md)）
5. ホスト LLM が「いつ・何を・なぜ決めたか」を時系列に並べ、関連する先行決定をつないで変遷として組み立てて返す

## decision-rationale との違い

- [decision-rationale](../decision-rationale/SKILL.md): **1 件**の決定の「なぜ」を provenance を遡って深掘る
- decision-log: 期間 / トピックの決定を**横断一覧**し、複数決定の変遷を俯瞰する

## 制約

- read-only。persist しない（イベントを書かない）
- 時間窓は `decisions` projection の `recorded_at` が対象（下限 inclusive `*After` / 上限 exclusive `*Before`）
- 本 skill は手順書のみで実処理を持たない
