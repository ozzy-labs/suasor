---
name: draft
description: 「リリース告知文書いて」「announcement 作って」「引き継ぎ書作って」「後任向け資料まとめて」と頼まれたら、Suasor MCP の search / decision.list / task.list / graph.related を読み取り系で集め、ホスト LLM が告知文または引き継ぎ書の text を構成して返す。persist しない（text-only）・外部投稿しない。
readOnly: true
category: draft
triggers:
  - リリース告知文書いて
  - announcement 作って
  - 引き継ぎ書作って
  - 後任向け資料まとめて
  - release notes 草案
pairs:
  - reply-draft
mcp_tools_read:
  - search
  - decision.list
  - task.list
  - graph.related
  - brief
mcp_tools_write: []
---

# draft

read-only な下書きの単一入口（[ADR-0046](../../adr/0046-agent-surface-contraction.md)）。**kind** で何を書くかを決める。text を返すだけで **persist も外部投稿もしない**。

以前は `announcement-draft` と `handoff-draft` に分かれていたが、どちらも「取り込み済みの材料を集めてホスト LLM が文章を組む」で、違うのは**集める材料と tone** だけだった。

> write（HITL）系の下書きは統合対象外 — 返信下書きは [reply-draft](../reply-draft/SKILL.md)、計画は [plan-draft](../plan-draft/SKILL.md)。read と write を 1 本にすると承認境界が壊れる（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md) / [ADR-0046](../../adr/0046-agent-surface-contraction.md) 決定 1）。

## いつ発火するか

| 言いかた | kind |
| --- | --- |
| 「リリース告知文書いて」「announcement 作って」「release notes 草案」「お知らせ案ほしい」 | `announcement` |
| 「引き継ぎ書作って」「handoff 書く」「後任向け資料まとめて」「業務引継メモほしい」 | `handoff` |

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

### kind=announcement

1. `decision.list`（`recordedAfter` = 前回リリース以降）で「決まったこと」を引く
2. `search` で関連する変更 context を補う
3. `brief` で対象期間の動きを取る
4. ホスト LLM が**告知 tone**（読み手は社外・他チーム。内輪の未完事項は出さない）で text を構成する

### kind=handoff

1. `task.list`（`state=in_progress`）で進行中の作業を引く
2. `decision.list` でその領域の決定を引く
3. `graph.related` / `search` で各作業の背景 source を辿る
4. ホスト LLM が**引き継ぎ tone**（読み手は後任。前提・未決事項・連絡先を明示）で text を構成する

## 制約

- **text-only**。persist しない・propose 経路を持たない・外部 SaaS に投稿しない（ユーザーが手で貼る）
- 文章の生成はホスト LLM 側。本 skill は材料の集め方のみを定める（[ADR-0006](../../adr/0006-ml-delegation.md)）
- 材料が薄いときは「材料が足りない」と言う。埋めるために推測で書かない
