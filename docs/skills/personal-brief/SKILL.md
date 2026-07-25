---
name: personal-brief
description: 「今日のまとめ」「今週どうなってる」「最近どう」「自分の状況」「先週の振り返り」と聞かれたら、指定期間（既定は直近 24h）の主要な動きを自分向けにまとめる。Suasor MCP の brief / search（mode=semantic） / task.list / decision.list / inbox.list を読み取り系で組み合わせて要約する。
readOnly: true
category: brief
triggers:
  - 今日のまとめ
  - 今週どうなってる
  - 最近どう
  - 自分の状況
  - 先週の振り返り
pairs:
  - external-brief
mcp_tools_read:
  - search
  - brief
  - priority.list
  - task.list
  - decision.list
  - inbox.list
  - demand.list
  - commitment.list
mcp_tools_write: []
---

# personal-brief

自分向けの状況サマリ。「最近どうなってる」を read-only で組み立てる。pair: 外向きは [external-brief](../external-brief/SKILL.md)。

## いつ発火するか

- 「今日のまとめ」「今週どうなってる」「今月の動き」「先週の状況」「先月の振り返り」
- 「最近どうなってる」「状況教えて」「自分の状況」

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。副作用なし・エージェント自律 OK。

1. 期間を決める。明示がなければ直近 24h。ISO 8601（offset 付き）の `since` を作る
2. `brief` で期間サマリを取る（LLM 要約。委譲先で生成、[ADR-0006](../../adr/0006-ml-delegation.md)）。`brief` の `demand` は **un-acked のみ**（対応済み / 不要と印された mention は除外・[ADR-0041](../../adr/0041-neutral-demand-priority-substrate.md)）＝「未処理」が真
   - **打切りを確認する**（[ADR-0007](../../adr/0007-connector-contract.md)「no silent wrong answer」）: `brief` は各 section を `limit`（既定 50）で打ち切ると `truncated.<section>`（`sources` / `tasks` / `decisions` / `inbox` / `demand`）を `true` で返す。多忙な日ほどバンドルが黙って過小申告する合図なので、`true` の section があれば要約をそのまま鵜呑みにしない。**窓を狭める**（`since` を近づける / `until` を切る）で該当期間を分割して取り直すか、その section に対応する list tool（`source.list` / `task.list` / `decision.list` / `inbox.list` / `demand.list`）を `limit` を上げて / 時間窓でページングして完全な一覧を引く
3. 補強が要れば次を叩く（時間フィルタは下限 inclusive `*After` / 上限 exclusive `*Before`）:
   - `priority.list` — 「いま何が優先か」の決定論的 cross-entity ランキング（tasks + open commitments + un-acked demand を固定 comparator で合成、[ADR-0041](../../adr/0041-neutral-demand-priority-substrate.md) 決定 3）。状況要約の「やるべきこと」節はこの基線を消費する（順位を散文で作り直さない）
   - `task.list`（`updatedAfter=since`）— 動いた task
   - `decision.list`（`recordedAfter=since`）— 記録された決定
   - `inbox.list`（`state=open`）— 未処理シグナル
   - `demand.list`（`observedAfter=since`）— connector 中立の未処理 demand（Slack @mention/DM + demand 相当の github notification。「読むべきが未処理」、[ADR-0012](../../adr/0012-slack-demand-digest.md) / [ADR-0041](../../adr/0041-neutral-demand-priority-substrate.md)）。既定は un-acked のみ。`selfUserId` 未設定時 slack は DM のみ。各 demand の `channelName` / `userName`（ローカル join した人間可読名、[ADR-0037](../../adr/0037-slack-name-enrichment.md) §10）で要約に **id ではなく名前**（「`#<channelName>` の `<userName>` から」）を出し、`null`（未解決）のときだけ `meta` の生 id に fallback する（id-only が続くなら `slack resolve-names` で遡及解決、§11）
   - `commitment.list`（`state=open`）— 未解決の commitment（約束/コミットメント。「能動的にやるべき約束」、[ADR-0021](../../adr/0021-commitment-ledger.md)）
   - `search`（`mode=semantic`） — トピックの関連 context（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
4. 集めた結果をホスト LLM が「主要な動き」として要約して返す

## 制約

- read-only。persist しない（イベントを書かない）
- LLM 推論ループは外部ホスト（Claude Code 等）側。本 skill は手順書のみで実処理を持たない
- 時間窓は各 projection の自然な timestamp 列が対象（task/inbox=`updated_at`、decision=`recorded_at`）
