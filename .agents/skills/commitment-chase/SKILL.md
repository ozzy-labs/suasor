---
name: commitment-chase
description: 「催促して」「借りてる約束」「相手の約束で期限切れ」「フォローアップしたい約束」「相手に頼んだやつどうなった」と頼まれたら、Suasor MCP の commitment.list（state=open, direction=owed_to_me）で相手が負う約束を引き、期限超過分をホスト側で抽出し、graph.related で各約束の出所 source を辿って「誰に・何を・いつ」を再構成して催促文ドラフトを text-only で提示する。read-only / persist なし / egress なし（ユーザーが手で送る）。pair: commitment-review（受動・自分が負う約束の台帳管理）。
---

# commitment-chase

相手が負う約束（`owed_to_me`）のうち**期限超過**のものを surface し、催促文ドラフトを組み立てる read skill。[commitment-review](../commitment-review/SKILL.md) が「自分が負う約束の受動的な台帳管理」なのに対し、本 skill は「相手への能動的な催促」を補完する対の skill（[ADR-0021](../../adr/0021-commitment-ledger.md) の台帳を read で合成）。**新 MCP tool は不要**で、既存 read tool の合成で実現する（[ADR-0008](../../adr/0008-assistant-skills.md) の skill 設計）。

## いつ発火するか

- 「催促して」「フォローアップしたい約束」
- 「借りてる約束」「相手に頼んだやつどうなった」
- 「相手の約束で期限切れ」「貸してる約束の期限切れ」

## 何をするか（MCP tool flow）

すべて read tool（[ADR-0004](../../adr/0004-mcp-agent-boundary-and-hitl.md)）。副作用なし・エージェント自律 OK。**専用 tool は追加しない**（既存合成、[ADR-0008](../../adr/0008-assistant-skills.md)）。

1. `commitment.list`（`state=open`, `direction=owed_to_me`）で相手が負う未解決の約束を引く。各 commitment は `title` / `dueDate?` / `person?` / `updated_at`（[ADR-0021](../../adr/0021-commitment-ledger.md)）
2. 期限超過（`dueDate` が現在時刻より過去）の約束をホスト側で抽出する。overdue 判定は read 時のホスト側合成（`dueDate < now`）で行う。`dueDate` を持たない約束は催促対象外（期限がないため）として別枠で軽く触れるに留める
3. `graph.related`（各 commitment id 起点、`direction=in`）で約束の出所 source を辿り、`source.get` で本文を補って「誰に・何を・いつ約束してもらったか」を再構成する（provenance、[ADR-0018](../../adr/0018-knowledge-graph-traversal.md)）
4. ホスト LLM が期限超過の約束ごとに催促文ドラフトを **text-only** で組み立てて提示する。`person` 別にまとめ、緊急度（超過日数）順に並べる

## 制約

- read-only。persist しない（イベントを書かない）。台帳の状態遷移（resolve / dismiss）は [commitment-review](../commitment-review/SKILL.md) skill へ HITL 橋渡しする
- **egress なし**。催促文は text-only ドラフトで返すだけで、外部 SaaS へ送信しない。ユーザーが内容を確認して手で送る（[ADR-0003](../../adr/0003-local-first-and-content-minimization.md) / HITL）
- overdue は現在時刻依存のためホスト側の read 時合成。台帳の `dueDate` は不変 context として扱い、id には含めない（[ADR-0021](../../adr/0021-commitment-ledger.md)）
- 本 skill は手順書のみで実処理を持たない
