---
name: catchup
description: 「前回以降の差分」「久しぶりに確認」「最後に見てから何が変わった」「不在中の動き」と頼まれたら、ホスト側で保持する seen-marker（最終確認時刻）を since として、Suasor MCP の source.list / task.list / decision.list / inbox.list を時間フィルタで合成し、前回以降の差分だけを要約する。専用 MCP tool は使わない。
---

# catchup

「前回確認した時点からの差分」を組み立てる。21 skill のうち本 skill だけ専用 MCP tool を持たず、既存 read tool + host 側 seen-marker で合成する（mcp-surface レビュー D1 確定）。

## いつ発火するか

- 「前回以降の差分」「久しぶりに確認」「最後に見てから何が変わった」「不在中の動き」

## 何をするか（MCP tool flow）

read tool のみ（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。**専用 tool は追加しない**（[mcp-surface.md](../../design/mcp-surface.md) の D1 方針）。

1. seen-marker（最終確認時刻）を `since` として取る。marker は **host（Claude Code 等）側で保持**する。server は永続 marker を持たない（local-first / stateless read surface）
2. `since` を各 read tool の下限 inclusive 時間フィルタに渡して差分を集める:
   - `source.list`（`observedAfter=since`）— 新規・更新ソース
   - `task.list`（`updatedAfter=since`）— 動いた task
   - `decision.list`（`recordedAfter=since`）— 記録された決定
   - `inbox.list`（`updatedAfter=since`）— 仕分けの変化
3. ホスト LLM が「前回以降に何が変わったか」として要約して返す
4. 応答後、host 側で seen-marker を現在時刻に更新する（次回 catchup の `since`）

## 制約

- read-only。persist しない。server 側に marker を残さない
- 時間フィルタは下限 inclusive（`>=`）/ 上限 exclusive（`<`）。`since = last_seen` を各 `*After` に渡す
- server 側 marker が必要と判断された場合に限り、別 Issue で専用 `catchup` read tool を検討する（本 skill の scope 外）
