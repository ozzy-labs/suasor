---
name: handoff-draft
description: 「引き継ぎ書作って」「handoff 書く」「後任向け資料まとめて」「業務引継メモほしい」と頼まれたら、Suasor MCP の task.list（state=in_progress）+ decision.list + recall.search + graph.related を読み取り系で組み立て、ホスト LLM が引き継ぎ書 text を構成して返す。persist しない（text-only）。propose 経路を持たず、ユーザーが手で SaaS に貼り付ける。
readOnly: true
category: draft
triggers:
  - 引き継ぎ書作って
  - handoff 書く
  - 後任向け資料まとめて
  - 業務引継メモほしい
pairs: []
mcp_tools_read:
  - task.list
  - decision.list
  - recall.search
  - graph.related
mcp_tools_write: []
---

# handoff-draft

後任向けの引き継ぎ書 text を組み立てる。read-only・text-only。

## いつ発火するか

- 「引き継ぎ書作って」「handoff 書く」「後任向け資料まとめて」「業務引継メモほしい」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `task.list`（`state=in_progress`）で進行中 task を引く（＝引き継ぐべき作業）
2. `decision.list` で関連する決定・方針を引く（後任が背景を理解できるよう）
3. `recall.search` で各 task の関連やりとりを補強する（embedding 無効時は `signal: embedding_disabled` を見て `search`（FTS）へフォールバック、[ADR-0005](../../adr/0005-fts-first-retrieval-embedding-sidecar.md)）
4. `graph.related` で task / decision に紐づく source を辿り、参照先をまとめる
5. ホスト LLM が引き継ぎ書 text（進行中作業 / 背景決定 / 関連資料 / 次の一手）を構成して返す

## 制約

- read-only。persist しない（text-only）
- `propose.generate` を経由せず候補保存 / apply 経路を持たない
- ユーザーが受け取った text を手で SaaS（Notion / Confluence / docs / Slack 等）に貼り付ける
- ファイルで欲しい場合は `draft.export`（HITL write）で `.md` / `.txt` にローカル書き出しできる（送信はしない・[ADR-0025](../../adr/0025-local-draft-export.md)）
- 本 skill は手順書のみで実処理を持たない
