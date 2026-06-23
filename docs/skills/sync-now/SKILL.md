---
name: sync-now
description: 「最新を取り込んでから状況教えて」「Slack 同期して」「sync して」「最新に更新して」「<connector> を今すぐ取り込んで」と頼まれたら、Suasor MCP の connector.sync で有効な connector の read 専用 ingest pass を走らせ、ソースの鮮度を担保する。personal-brief / next-actions など読み取り系の前段に使える。
readOnly: false
category: retrieval
triggers:
  - 最新を取り込んでから状況教えて
  - Slack 同期して
  - sync して
  - 最新に更新して
  - connector を今すぐ取り込んで
pairs: []
mcp_tools_write:
  - connector.sync
---

# sync-now

会話から connector の **read 専用 ingest pass** を走らせ、ローカルストアの鮮度を担保する HITL write skill（[ADR-0027](../../adr/0027-bulk-sync-orchestration.md) / [ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。Suasor の中核価値「散在した業務情報を手元に集める」は、定期的に sync しないと常に古くなる。`personal-brief` / `next-actions` / `research` など読み取り系を実行する前段に使い、「最新を取り込んでから」のニーズに応える。CLI `suasor sync` の会話版に相当する。

## いつ発火するか

- 「最新を取り込んでから状況教えて」「最新に更新して」
- 「Slack 同期して」「`<connector>` を今すぐ取り込んで」
- 「sync して」

## 何をするか（MCP tool flow）

1. どの connector を対象にするか（全有効 connector か、特定の connector か）を確認する
2. `connector.sync` を呼んで ingest pass を走らせる。差分は fingerprint / cursor で検知され、同一データの再実行は event を重複 append しない（冪等・[ADR-0007](../../adr/0007-connector-contract.md) FR-ING-3）
3. 取り込み結果（connector ごとの件数）を要約する。後続の読み取り系 skill（`personal-brief` 等）に繋げる

## 制約

- ingest は **read 専用**で外部への書き込み・送信は発生しない（egress ゼロ・[ADR-0003](../../adr/0003-local-first-and-content-minimization.md) / [ADR-0027](../../adr/0027-bulk-sync-orchestration.md)）。`connector.sync` は MCP 上は write tool（ローカルに event を append するため）だが、HITL 原則を破る外部送信は伴わない
- 1 connector の失敗が全体を止めない（continue-on-error）。失敗は status で報告する
- **定期実行は本 skill の責務ではない**。常駐 watch は採らず、cron / launchd / systemd timer による `suasor sync` の定期実行に委譲する（[ADR-0027](../../adr/0027-bulk-sync-orchestration.md)・[docs/guide/scheduling.md](../../guide/scheduling.md)）。本 skill は「今すぐ取り込む」one-shot 用
- 本 skill は手順書のみで実処理を持たない
