---
name: person-cleanup
description: 「同一人物をまとめて」「people を整理」「この handle とこの handle は同じ人」「person を分離」「重複した人物」と頼まれたら、Suasor MCP の person.list で解決済み person と各 connector identity を引き、重複候補をユーザーに提示して確認を取った上で、承認分のみ person.merge で統合する。過剰 merge の訂正は person.split で行う。自動 fuzzy 同定はしない。
readOnly: false
category: identity
triggers:
  - 同一人物をまとめて
  - people を整理
  - この handle とこの handle は同じ人
  - person を分離
  - 重複した人物
pairs: []
mcp_tools_read:
  - person.list
mcp_tools_write:
  - person.merge
  - person.split
---

# person-cleanup

connector author handle から投影された person の重複を、operator の判断で統合 / 分離する HITL write skill。connector identity は初期に **1 handle = 1 person** で投影され（自動 fuzzy 同定なし）、同一人物の重複統合は人が明示的に行う（[ADR-0022](../../adr/0022-person-identity-resolution.md) / [ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。

## いつ発火するか

- 「同一人物をまとめて」「people を整理」「重複した人物を統合」
- 「この handle とこの handle は同じ人」（merge）
- 「person を分離」「merge しすぎたので戻して」（split）

## 何をするか（MCP tool flow）

read で集めて、write は HITL。**自動 fuzzy 同定はしない**（ADR-0022 で却下。同一判断は人が下す）。

1. `person.list` で解決済み person を新しい更新順に引く。各 person は `id` / `displayName` / `identityCount` / `identities[]`（`connector` / `handle` / `displayName`）。merge で空になった tombstone も見るなら `includeEmpty: true`
2. 同名・同 handle・connector 跨ぎなどから**重複候補をホスト側で推定し、ユーザーに提示して確認を取る**（同定の最終判断は人。本 skill は候補提示まで）
3. ユーザーが「同一人物」と確認したペアのみ `person.merge`（`targetPersonId` / `sourcePersonId`）で統合する。source の identity が target に付け替わり、source は空になる（可逆・event で監査可能）
4. 過剰 merge を訂正するときは `person.split`（`connector` / `handle` / `newPersonId?`）で identity を別 person に分離する。`newPersonId` 省略時は identity 本来の content 由来 person（merge を巻き戻す既定の戻り先）へ送る

## 制約

- HITL。人の承認なしに `person.merge` / `person.split` を呼ばない。auto-apply しない。自動 fuzzy 同定もしない。`person.list` は read（確認）
- self-merge（同一 id）/ 未知の source person は tool error。既に空の person の再 merge は `noop`（idempotent）。未知 identity の split は tool error、解決済みなら `noop`
- merge / split は逆操作の対。`person.split` は `person.merge` の巻き戻しに使える
- 本 skill は手順書のみで実処理を持たない
