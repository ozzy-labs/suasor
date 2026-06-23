---
name: task-publish
description: 「このタスク GitHub に起票して」「Jira のチケット完了にして」「あの issue にコメント付けて」「タスクを外部に publish して」「ticket を再オープンして」と頼まれたら、Suasor MCP の task.list で対象 task を特定し、ユーザー確認後に task.publish で外部ホーム（GitHub Issues / Jira / Slack List）へ起票、または task.act で complete / reopen / comment を遠隔操作する。auto-apply 経路は存在しない。
readOnly: false
category: task
triggers:
  - このタスク GitHub に起票して
  - Jira のチケット完了にして
  - あの issue にコメント付けて
  - タスクを外部に publish して
  - ticket を再オープンして
pairs:
  - task-update
mcp_tools_read:
  - task.list
mcp_tools_write:
  - task.publish
  - task.act
---

# task-publish

確定タスクを**外部ホーム**（GitHub Issues / Jira / Slack List）へ起票し、状態を遠隔操作する HITL write skill（[ADR-0036](../../adr/0036-task-external-home.md) / [ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。Suasor は「横断捕捉・AI 提案・優先付け・由来」に徹し、確定タスクの**住処は外部ツール 1 つ**に委ねる（single pane）。`tasks` projection は状態の正本ではなく、優先ビュー表示用の読み取りキャッシュ + provenance として残る（状態の正本は外部ホーム＝[ADR-0036](../../adr/0036-task-external-home.md) D1）。`task-update` が Suasor 内 lifecycle を動かすのに対し、本 skill は**外部への egress write / 遠隔操作**を担う。

## いつ発火するか

- 「このタスク GitHub に起票して」「タスクを外部に publish して」（→ `task.publish`）
- 「Jira のチケット完了にして」「あの ticket を done に」（→ `task.act` complete）
- 「再オープンして」「やっぱり open に戻して」（→ `task.act` reopen）
- 「あの issue にコメント付けて」「進捗をコメントしといて」（→ `task.act` comment）

## 何をするか（MCP tool flow）

read で対象を特定して、egress write は HITL。**auto-apply 経路は存在しない**（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。egress（外部送信）を伴うため、ローカル draft.export 以上に確認は厳格にする（[ADR-0003](../../adr/0003-local-first-and-content-minimization.md) §egress 境界）。

1. `task.list`（`state` で絞り可）で対象 task を特定する。各 task は `id` / `title` / `state` / 既存の外部 id（publish 済みか）
2. どの task をどのホーム（GitHub / Jira / Slack List）にどう操作するかを**ユーザーに提示して確認を取る**（native framing: ホスト側で人の承認を促す）。送信先・本文（コメント等）を明示する
3. 承認後:
   - 未起票の確定タスク → `task.publish`（設定済みの**単一タスクホーム**へ起票。`TaskPublished` を append、外部 id を記録）
   - 起票済みタスク → `task.act`（`complete` / `reopen` / `comment`。`TaskActionIssued` を append）

## 制約

- HITL。人の承認なしに `task.publish` / `task.act` を呼ばない。auto-apply しない。`task.list` は read（特定）
- **行き先は単一のタスクホーム**（[ADR-0036](../../adr/0036-task-external-home.md) D2）。per-task の行き先上書きは初期スコープ外（既定では出さない）
- **冪等・二重起票回避**: actuator は冪等 label（例 `suasor` + `suasor-task-<id>`）で同一タスクの重複起票を防ぐ。「外部起票成功 → ローカル event append 失敗」の二重起票リスクに注意し、再実行時は既存外部 id を確認してから操作する
- connector（read 専用・[ADR-0007](../../adr/0007-connector-contract.md)）と actuator（write）は型レベルで別 capability。actuator 未実装のソースへは publish できない（status で報告、throw しない）
- Slack List actuator は comment 非対応など、ホームごとに対応操作に差がある（[ADR-0036](../../adr/0036-task-external-home.md)）。非対応操作は `unsupported` として報告する
- 本 skill は手順書のみで実処理を持たない
