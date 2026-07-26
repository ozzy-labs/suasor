---
name: decisions
description: 「今月の決定」「直近の意思決定一覧」「あの決定はなぜ」「X を選んだ理由」「なんで A じゃなくて B にしたんだっけ」と聞かれたら、Suasor MCP の decision.list + graph.related + search を読み取り系で組み合わせ、決定の一覧・変遷、または 1 件の決定の経緯・根拠を返す。read-only。
readOnly: true
category: decision
triggers:
  - 今月の決定
  - 直近の意思決定一覧
  - あの決定はなぜ
  - X を選んだ理由
  - この方針の根拠は?
pairs:
  - find
mcp_tools_read:
  - decision.list
  - graph.related
  - search
  - source.get
mcp_tools_write: []
---

# decisions

意思決定を引く単一入口（[ADR-0046](../../adr/0046-agent-surface-contraction.md)）。**mode** で「一覧・変遷」と「1 件の根拠」を切り替える。read-only。

以前は `decision-log`（一覧）と `decision-rationale`（根拠）に分かれていたが、どちらも `decision.list` + `graph.related` で、違いは**何件を、どこまで深く**だけだった。

## いつ発火するか

| 言いかた | mode |
| --- | --- |
| 「今月の決定」「直近の意思決定一覧」「[topic] の決定履歴」「決定の変遷を追いたい」 | `log`（既定） |
| 「あの決定はなぜ」「X を選んだ理由」「なんで A じゃなくて B に」「この方針の根拠は?」 | `rationale` |

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

### mode=log（既定）

1. `decision.list`（`recordedAfter` / `recordedBefore`、トピック絞りは結果側で）で対象期間の決定を引く
2. 各決定について `graph.related` で**背景 source** を 1 hop 辿る（decision→source の `derived_from` のみ。決定どうしを直接つなぐ辺は無い — 下記「先行決定の辿りかた」）
3. **時系列に並べ、変遷（何が何を置き換えたか）が分かる形**でまとめる

### mode=rationale

1. `decision.list` で対象の決定を特定する（曖昧なら候補を提示して選んでもらう）
2. `graph.related` で provenance を辿る — **その決定の根拠になった source**
3. `source.get` で根拠 source の本文を読む
4. `search` で当時の議論を補強する
5. **決定 + 経緯 + 根拠 source**（+ 辿れた場合の先行決定）を組み立てて返す。却下された選択肢が記録されていればそれも示す

### 先行決定の辿りかた（辺が無いことを前提にする）

reducer が張る決定まわりの辺は **decision → source の `derived_from` だけ**で、**決定どうしを直接つなぐ辺は存在しない**。したがって「先行決定」は次のどちらかでしか辿れない:

1. **共有 source 経由の 2 hop** — 決定の根拠 source から `graph.related` を逆向きに辿り、同じ source を根拠に持つ別の決定を見る。同じ議論から複数の決定が出た場合にだけ当たる
2. **手で張った `manual_link`** — `link.add`（write / HITL）で決定間に明示的に張られていれば `graph.related` に出る

**1 hop で何も返らないことを「先行決定は無い」と言い換えてはならない**（[ADR-0007](../../adr/0007-connector-contract.md) の "no silent wrong answer"）。辿れなかったときは「provenance link には記録が無い」と述べ、必要なら `search` で当時の議論を補う。

## 制約

- read-only。persist しない（決定の**記録**は `decision.record`、HITL）
- 根拠は provenance link に基づく。記録が無いものを推測で補わない（「記録が無い」と言う方が有用）
