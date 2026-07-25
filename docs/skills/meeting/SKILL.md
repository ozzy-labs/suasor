---
name: meeting
description: 「来週の会議準備」「明日のミーティング前確認」「あの会議から何が実装されたか」「会議で決めた action item の進捗」と頼まれたら、Suasor MCP の source.list（calendar）+ search + graph.related + task.list を読み取り系で組み合わせ、会議前の context または会議後の実装進捗を返す。read-only。
readOnly: true
category: meeting
triggers:
  - 来週の会議準備
  - 明日のミーティング前確認
  - あの会議から何が実装されたか
  - 会議で決めた action item の進捗
  - 打ち合わせ前に状況教えて
pairs:
  - meeting-followup
mcp_tools_read:
  - source.list
  - source.get
  - search
  - graph.related
  - task.list
  - decision.list
mcp_tools_write: []
---

# meeting

会議まわりの read 系単一入口（[ADR-0046](../../adr/0046-agent-surface-contraction.md)）。**phase** で会議の前後を切り替える。read-only。pair: 会議直後の action item 抽出（write / HITL）は [meeting-followup](../meeting-followup/SKILL.md)。

以前は `meeting-prep`（前）と `action-item-status`（後）に分かれていた。どちらも「あの会議まわりで何がある / どうなった」であり、違いは**時間の向き**だけである。

## いつ発火するか

| 言いかた | phase |
| --- | --- |
| 「来週の会議準備」「明日のミーティング前確認」「次の会議の context」「打ち合わせ前に状況教えて」 | `prep`（既定） |
| 「あの会議から何が実装されたか」「会議で決めた action item の進捗」「決めたことの実装状況」 | `status` |

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

### phase=prep

1. `source.list` で対象の calendar event を引く。**時間フィルタは開始時刻で絞る**（更新時刻ではない — この取り違えが「3 か月前に作られた明日の会議」を落としていた。[ADR-0044](../../adr/0044-calendar-proximity-signals.md) 決定 2）
2. `source.get`（`externalId`）で event 本文・議題を取る
3. `search` で過去の関連やりとりを引く
4. `graph.related` で関連 decisions / sources を辿る
5. **目的 / 過去文脈 / 関連 decisions / 参考 sources** を組み立てて返す

### phase=status

1. `source.list` で対象の会議 event を特定する
2. `graph.related` でその会議に由来する task / decision を辿る
3. `task.list`（`state`）で各 task の現在状態を引く
4. **決めたことごとに「実装された / 進行中 / 手つかず」**を対応付けて返す

## 制約

- read-only。persist しない（action item の**登録**は `meeting-followup`、HITL）
- calendar が未取り込みなら該当 connector の sync を案内する
- 会議由来かどうかの判定は provenance link（`graph.related`）に基づく。推測で紐付けない
