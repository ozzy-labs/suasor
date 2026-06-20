---
name: slack-triage
description: 「Slack の未処理を捌いて」「mention/DM まとめて」「Slack で呼ばれてるやつ」「Slack の未読対応」と頼まれたら、Suasor MCP の slack.demand.list（@mention / DM の未処理 signal）を集めて緊急度・種別で整理し、action が要るものは inbox.add で捕捉 / source.get → propose.generate(source_extract) で task・decision・返信下書き候補へ橋渡しする。demand の列挙は read で自律 OK、書き込み橋渡しは HITL。
readOnly: true
category: triage
triggers:
  - Slack の未処理を捌いて
  - mention/DM まとめて
  - Slack で呼ばれてるやつ
  - Slack の未読対応
pairs: []
mcp_tools_read:
  - slack.demand.list
  - source.get
mcp_tools_write: []
---

# slack-triage

Slack の @mention / DM を「読むべきが未処理」signal として集約し、捌く read 中心 skill（[ADR-0012](../../adr/0012-slack-demand-digest.md) / [ADR-0013](../../adr/0013-slack-engagement-axis.md)）。demand の列挙は read で自律 OK、action 化（task / decision / 返信 / inbox 捕捉）は HITL で橋渡しする（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。`next-actions` / `personal-brief` が状況 signal として取り込む demand を、Slack 起点で正面から扱う。

## いつ発火するか

- 「Slack の未処理を捌いて」「Slack の未読対応」
- 「mention/DM まとめて」「Slack で呼ばれてるやつ」「@ 付き拾って」

## 何をするか（MCP tool flow）

read で集めて、action 化（write）は HITL（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

1. `slack.demand.list` で未処理 signal を集める。`kinds`（`mention` / `dm`）/ `selfUserId`（mention 用、未指定時は config の `self_user_id`）/ `observedAfter` / `observedBefore` で絞る。取り込み済み `slack_message` source からの **query 導出**で、専用 projection は持たない（[ADR-0012](../../adr/0012-slack-demand-digest.md)）。各 demand は source の `externalId` / `body` / `observedAt` + `kind`
2. demand を kind（mention / dm）・新しさで整理し、**ユーザーに提示する**（ここまで read で自律 OK）
3. action が要るものは HITL で橋渡しする（人の承認後のみ）:
   - **受信箱に捕捉** — `inbox.add`（`sourceExternalId`）で `open` 捕捉し、以後 `inbox-triage` で解決する
   - **task / decision / 返信下書き化** — `source.get` で本文を読み、`propose.generate`（mode=`source_extract`）で候補を生成 → `propose.list` で確認 → 承認分のみ `propose.apply`（`source-extract` と同じ flow）
   - **返信したいだけ** — `reply-draft` skill（`propose.generate` mode=`reply_draft`、`reply_to_source_id` 指定）へ

## 制約

- read 中心。`slack.demand.list` は read（自律 OK）。`inbox.add` / `propose.apply` 等の書き込みは HITL（人の承認なしに呼ばない・auto-apply なし）
- `selfUserId` も config の `self_user_id` も無いと mention は無効化され DM のみ返る（`kinds: ["mention"]` 指定時は空）
- demand は導出 view（新規 table なし）。`mention` = `body` に `<@uid>` を含む / `dm` = channel id が `D` 始まり（[ADR-0012](../../adr/0012-slack-demand-digest.md)）
- 本 skill は手順書のみで実処理を持たない
