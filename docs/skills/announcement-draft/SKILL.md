---
name: announcement-draft
description: 「リリース告知文書いて」「announcement 作って」「アナウンス文章まとめて」「release notes 草案」「お知らせ案ほしい」と頼まれたら、Suasor MCP の recall.search（関連 release / change context）+ decision.list（recorded_after=last_release）+ brief（告知 tone）を読み取り系で組み立て、ホスト LLM が告知文 text を構成して返す。persist しない（text-only）。propose 経路を持たず、ユーザーが手で SaaS に投稿する。
readOnly: true
category: draft
triggers:
  - リリース告知文書いて
  - announcement 作って
  - アナウンス文章まとめて
  - release notes 草案
  - お知らせ案ほしい
pairs: []
mcp_tools_read:
  - recall.search
  - decision.list
  - brief
mcp_tools_write: []
---

# announcement-draft

リリース告知文 / お知らせの text を組み立てる。read-only・text-only。

## いつ発火するか

- 「リリース告知文書いて」「announcement 作って」「アナウンス文章まとめて」
- 「release notes 草案」「お知らせ案ほしい」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `recall.search` で関連 release / change context を引く（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
2. `decision.list`（`recordedAfter=last_release`）で前回リリース以降に記録された決定・変更を引く
3. `brief` で告知 tone のまとめ素材を作る（LLM 要約。委譲先で生成、[ADR-0006](../../adr/0006-ml-delegation.md)）
4. ホスト LLM が告知文 text（ハイライト / 変更点 / 影響 / 次のステップ）を構成して返す

## 制約

- read-only。persist しない（text-only）
- `propose.generate` を経由せず候補保存 / apply 経路を持たない
- ユーザーが受け取った text を手で SaaS（Slack / Notion / GitHub release / メール 等）に投稿する
- ファイルで欲しい場合は `draft.export`（HITL write）で `.md` / `.txt` にローカル書き出しできる（送信はしない・[ADR-0025](../../adr/0025-local-draft-export.md)）
- 本 skill は手順書のみで実処理を持たない
