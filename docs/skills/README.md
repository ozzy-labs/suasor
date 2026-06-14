# Assistant Skills

[ADR-0008](../adr/0008-assistant-skills.md)。自然文トリガのアシスタント skill 群。SSOT は `docs/skills/<name>/SKILL.md`、`suasor skills install` で `.claude/skills/` `.agents/skills/` に展開する。read 系はエージェント自律 OK、write 系は HITL（auto-apply なし、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

> 本ファイルは catalog（責務と発火条件の一覧）。各 `<name>/SKILL.md` 本体は別 Issue で作成する。

## Read 系（自律 OK・11）

| skill | 発火例 | 主な MCP tool |
|---|---|---|
| `personal-brief` | 「今日のまとめ」「最近どう」 | brief / recall.search / task.list / decision.list |
| `next-actions` | 「次に何やる」「優先度高いのは」 | task.list / recall.search |
| `catchup` | 「前回以降の差分」「久しぶりに確認」 | (seen-marker ベースの差分要約) |
| `find-document` | 「あの資料」「<語>含むファイル」 | search (FTS) |
| `research` | 「<X>について調べて」「網羅的に」 | recall.search + search + graph.related + brief |
| `meeting-prep` | 「次の会議準備」「明日のMTG前確認」 | source.list(calendar) / recall.search / graph.related |
| `decision-rationale` | 「あの決定はなぜ」「Xを選んだ理由」 | decision.list / graph.related / recall.search |
| `external-brief` | 「上司向け週次」「クライアント向け進捗」 | task.list(completed) / decision.list / brief |
| `pr-review` | 「PR #N レビューして」 | recall.search (+ gh diff) |
| `handoff-draft` | 「引き継ぎ書作って」 | task.list / decision.list / recall.search（text-only・persist なし） |
| `announcement-draft` | 「リリース告知文」 | recall.search / decision.list / brief（text-only・persist なし） |

## HITL write 系（人の承認で適用・4）

| skill | 発火例 | 主な MCP tool |
|---|---|---|
| `reply-draft` | 「返信案考えて」「下書き作って」 | propose.generate(reply_draft) → propose.apply |
| `inbox-triage` | 「受信箱整理して」「未処理捌いて」 | inbox.list → propose.generate(inbox_triage) → propose.apply |
| `source-extract` | 「この資料からタスク抽出」 | source.get → propose.generate(source_extract) → propose.apply |
| `meeting-followup` | 「会議後のaction items」「議事録からタスク」 | source.list(calendar) → propose.generate(meeting_followup) → propose.apply |

エコシステム共通 dev skill（drive / lint / commit / ship / pr / review 等）は `@ozzylabs/skills` 経由で別供給（名前空間 disjoint）。
