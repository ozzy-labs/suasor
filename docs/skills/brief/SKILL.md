---
name: brief
description: 「今日のまとめ」「今週どうなってる」「前回以降の差分」「週次の棚卸し」「上司向け週次報告」「今どれくらい溜まってる」と聞かれたら、期間・読み手・観点を決めて状況をまとめる。Suasor MCP の brief / priority.list / task.list / decision.list / inbox.list / demand.list / commitment.list / search を読み取り系で合成する。read-only。
readOnly: true
category: brief
triggers:
  - 今日のまとめ
  - 今週どうなってる
  - 前回以降の差分
  - 週次の棚卸し
  - 上司向け週次報告
  - 今どれくらい溜まってる
pairs:
  - next-actions
mcp_tools_read:
  - brief
  - priority.list
  - task.list
  - decision.list
  - inbox.list
  - demand.list
  - commitment.list
  - search
mcp_tools_write: []
---

# brief

状況サマリの単一入口（[ADR-0046](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0046-agent-surface-contraction.md)）。**期間 × 読み手 × 観点**の 3 つで振る舞いを決める。read-only。

以前は `personal-brief` / `catchup` / `weekly-review` / `external-brief` / `health-check` の 5 本に分かれていたが、ユーザーから見ればすべて「まとめて」であり、違うのはパラメータだけだった（「今週どうなってる」の一言で 5 本が競合していた）。

## いつ発火するか

| 言いかた | period | audience | focus |
| --- | --- | --- | --- |
| 「今日のまとめ」「最近どう」「自分の状況」 | 24h（既定） | self | summary |
| 「前回以降の差分」「久しぶりに確認」「不在中の動き」 | 前回確認時刻から | self | summary |
| 「週次レビュー」「棚卸し」「今週やり残したこと」 | 7d | self | review |
| 「上司向け週次報告」「クライアント向け進捗」「外向きステータス」 | 指定期間 | **external** | summary |
| 「健全性チェック」「今どれくらい溜まってる」「数値で」 | 現在 | self | **numbers** |

明示がなければ `period=24h` / `audience=self` / `focus=summary`。

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0004-mcp-agent-boundary-and-hitl.md)）。副作用なし・エージェント自律 OK。

### 1. パラメータを決める

- **period** — ISO 8601（offset 付き）の `since` を作る。「前回以降」はホスト側が保持する seen-marker（最終確認時刻）を `since` にする（**専用の MCP tool は無い**。状態はホストが持つ）
- **audience** — `self`（既定）/ `external`（上司・顧客向け。tone と粒度が変わる）
- **focus** — `summary`（何が動いたか）/ `review`（未完・約束・滞留の棚卸し）/ `numbers`（件数のスナップショット）

### 2. focus 別に読む

**focus=summary**（既定）

1. `brief`（`since` / `until`）で期間バンドルを取る（要約文は生成しない＝[ADR-0006](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0006-ml-delegation.md) の ML 委譲。組み立てはホスト LLM）。**open commitment もバンドルに入る**（非時間軸・緊急度順・[#513](https://github.com/ozzy-labs/suasor/issues/513)）ので、`commitment.list` を別途叩く必要はない
2. 補強が要れば `priority.list`（いま何が優先か）/ `task.list`（`updatedAfter`）/ `decision.list`（`recordedAfter`）/ `inbox.list`（`state=open`）/ `demand.list`（`observedAfter`）/ `search`（トピック関連 context）

**focus=review**（棚卸し）

1. `task.list`（`state∈{open,in_progress}` + overdue 抽出）— 未完
2. `commitment.list`（双方向）— 自分が負う / 相手が負う約束
3. `inbox.list`（`state=open`）— 滞留
4. `brief`（`since=7d`）— 期間の動き
5. 落ちている項目を明示する。状態遷移そのものは `task-update` / `inbox-triage` / `commitment-review` skill へ HITL で橋渡しする（ここでは書かない）

**focus=numbers**（スナップショット）

`task.list`（overdue / 期日 7 日以内）+ `propose.list`（pending）+ `inbox.list`（open）+ `commitment.list`（open）の**件数**を出す。要約ではなく数値で返す。

**audience=external** のとき

`task.list`（`state=completed`, `updatedAfter=期間開始`）+ `decision.list`（`recordedAfter=期間開始`）を軸に、**完了したこと + 決まったこと**を外向き tone でまとめる。未完の内輪の詳細・個人名の生 id・未処理の山は出さない。

### 3. 打切りを必ず確認する

[ADR-0007](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0007-connector-contract.md)「no silent wrong answer」。`brief` は各 section を `limit`（既定 50）で打ち切ると `truncated.<section>` を `true` で返す。**多忙な期間ほどバンドルが黙って過小申告する**合図なので、`true` の section があれば要約を鵜呑みにせず、窓を狭めて取り直すか、対応する list tool でページングする。

### 4. 鮮度の警告を伝える

`brief` の `warnings` は「空なのは静かだからではなく、繋がっていない / 止まっているから」を示す（[#442](https://github.com/ozzy-labs/suasor/issues/442) / [#443](https://github.com/ozzy-labs/suasor/issues/443)）:

- `sync_stale` — 取り込みが遅れている。**サマリが古いデータに基づく**ことを明示する
- `commitment_scan_stale` — 未スキャンの material がある（約束を取りこぼしている可能性）
- `slack_not_configured` / `embedding_disabled` — 該当カテゴリが構造的に空

## 制約

- read-only。persist しない（イベントを書かない）
- 要約の生成はホスト LLM 側。本 skill は手順書のみで実処理を持たない
- 順位付けが要る場面では `priority.list` の基線を消費する（散文で順位を作り直さない）。根拠は各行の `explanation` を示す（`score` の数値は出さない・[ADR-0045](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0045-priority-ranking-model.md) 決定 4）
- demand の表示は `channelName` / `userName`（ローカル join した人間可読名・[ADR-0037](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0037-slack-name-enrichment.md)）を優先し、`null` のときだけ生 id に fallback する
- 時間窓は各 projection の自然な timestamp（task/inbox=`updated_at`、decision=`recorded_at`、source=`observed_at`）。下限 inclusive / 上限 exclusive
- `brief` の `demand` に **calendar は入らない**（[ADR-0044](https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0044-calendar-proximity-signals.md)）。近接は「窓」ではなく「いま」に対する量であり、窓の対象列は予定の**更新時刻**なので、含めると「その期間に編集された予定」を答えてしまう。これから始まる予定が要るときは `priority.list`（`starting_soon` / `prep`）か `demand.list`（`source="calendar"`）を別に引く
