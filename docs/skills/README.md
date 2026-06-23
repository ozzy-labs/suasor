# Assistant Skills

[ADR-0008](../adr/0008-assistant-skills.md)。自然文トリガのアシスタント skill 群。SSOT は `docs/skills/<name>/SKILL.md`、`suasor skills install` で `.claude/skills/` `.agents/skills/` に展開する。read 系はエージェント自律 OK、write 系は HITL（auto-apply なし、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。install 後の起動・確認・トラブルシュートは [利用ガイド](../guide/skills.md) を参照。

> 本ファイルは catalog（責務と発火条件の一覧）。各 skill の本体は `<name>/SKILL.md`（下表の skill 名からリンク）。frontmatter は `name` / 自然文トリガの `description` に加え、機械可読フィールド（`readOnly` / `category` / `triggers[]` / `pairs[]` / 任意の `mcp_tools_read/write[]`、[ADR-0032](../adr/0032-skill-frontmatter-schema.md)）+ 駆動する MCP tool flow を持つ。`suasor skills search` / `skills info` / `skills list --format=detailed` でこれらを CLI から引ける。

## Read 系（自律 OK・19）

各 skill が叩く完全な MCP tool 一覧は `suasor skills info <name>`（frontmatter の `mcp_tools_*` が SSOT・[ADR-0032](../adr/0032-skill-frontmatter-schema.md)）で引ける。下表の「主な MCP tool」は要約。

| skill | 発火例 | 主な MCP tool |
|---|---|---|
| [`personal-brief`](personal-brief/SKILL.md) | 「今日のまとめ」「最近どう」 | brief / recall.search / task.list / decision.list |
| [`next-actions`](next-actions/SKILL.md) | 「次に何やる」「優先度高いのは」 | task.list / recall.search |
| [`catchup`](catchup/SKILL.md) | 「前回以降の差分」「久しぶりに確認」 | (seen-marker ベースの差分要約) |
| [`find-document`](find-document/SKILL.md) | 「あの資料」「<語>含むファイル」 | search (FTS) |
| [`research`](research/SKILL.md) | 「`<X>`について調べて」「網羅的に」 | recall.search + search + graph.related + brief |
| [`meeting-prep`](meeting-prep/SKILL.md) | 「次の会議準備」「明日のMTG前確認」 | source.list(calendar) / recall.search / graph.related |
| [`decision-rationale`](decision-rationale/SKILL.md) | 「あの決定はなぜ」「Xを選んだ理由」 | decision.list / graph.related / recall.search |
| [`decision-log`](decision-log/SKILL.md) | 「今月の決定」「[topic] の決定履歴」 | decision.list / graph.related / brief |
| [`action-item-status`](action-item-status/SKILL.md) | 「あの会議から何が実装されたか」 | source.list(calendar) / graph.related / task.list |
| [`health-check`](health-check/SKILL.md) | 「健全性チェック」「滞留してるもの数えて」 | task.list / propose.list / inbox.list / commitment.list |
| [`external-brief`](external-brief/SKILL.md) | 「上司向け週次」「クライアント向け進捗」 | task.list(completed) / decision.list / brief |
| [`pr-review`](pr-review/SKILL.md) | 「PR #N レビューして」 | recall.search (+ gh diff) |
| [`handoff-draft`](handoff-draft/SKILL.md) | 「引き継ぎ書作って」 | task.list / decision.list / recall.search（text-only・persist なし） |
| [`announcement-draft`](announcement-draft/SKILL.md) | 「リリース告知文」 | recall.search / decision.list / brief（text-only・persist なし） |
| [`provenance-trace`](provenance-trace/SKILL.md) | 「この task の出どころ」「由来を辿って」 | graph.related / graph.expand(direction=in) / source.get |
| [`doc-diff`](doc-diff/SKILL.md) | 「前回から何が変わった」「この資料の差分」 | source.history（event log の本文版）+ graph.related |
| [`doc-review`](doc-review/SKILL.md) | 「この設計書レビューして」「仕様のレビュー」 | source.get + recall.search / decision.list / graph.related |
| [`commitment-chase`](commitment-chase/SKILL.md) | 「催促して」「相手の約束で期限切れ」 | commitment.list(owed_to_me) + graph.related / source.get（text-only・persist なし） |
| [`weekly-review`](weekly-review/SKILL.md) | 「週次レビュー」「棚卸し」 | task.list(overdue) / commitment.list / inbox.list / brief |

## HITL write 系（人の承認で適用・13）

| skill | 発火例 | 主な MCP tool |
|---|---|---|
| [`reply-draft`](reply-draft/SKILL.md) | 「返信案考えて」「下書き作って」 | propose.generate(reply_draft) → propose.apply / draft.export |
| [`slack-triage`](slack-triage/SKILL.md) | 「Slack の未処理を捌いて」「mention/DM まとめて」 | slack.demand.list → inbox.add / source.get → propose.generate(source_extract) → propose.apply |
| [`inbox-triage`](inbox-triage/SKILL.md) | 「受信箱整理して」「未処理捌いて」 | inbox.list → propose.generate(inbox_triage) → task.create / propose.apply |
| [`source-extract`](source-extract/SKILL.md) | 「この資料からタスク抽出」 | source.get → propose.generate(source_extract) → propose.apply |
| [`meeting-followup`](meeting-followup/SKILL.md) | 「会議後のaction items」「議事録からタスク」 | source.list(calendar) → propose.generate(meeting_followup) → propose.apply |
| [`commitment-review`](commitment-review/SKILL.md) | 「約束をスキャンして」「貸し借り確認」 | propose.generate(commitment_scan) → propose.apply / commitment.list → resolve / dismiss / reopen |
| [`proposal-review`](proposal-review/SKILL.md) | 「保留中の提案を確認」「pending を捌いて」 | propose.list(pending) → propose.apply / propose.reject / propose.batch |
| [`person-cleanup`](person-cleanup/SKILL.md) | 「同一人物をまとめて」「people を整理」 | person.list → person.merge / person.split |
| [`task-update`](task-update/SKILL.md) | 「これ終わった」「完了にして」「task を進行中に」 | task.list → task.update |
| [`task-publish`](task-publish/SKILL.md) | 「GitHub に起票して」「Jira を完了に」「issue にコメント」 | task.list → task.publish / task.act |
| [`plan-draft`](plan-draft/SKILL.md) | 「これを分解して」「計画に落として」 | source.get / recall.search → propose.generate(source_extract) → propose.apply / draft.export |
| [`source-forget`](source-forget/SKILL.md) | 「あの誤取り込みを消して」「この source を忘れて」 | search / source.list → source.forget |
| [`sync-now`](sync-now/SKILL.md) | 「最新を取り込んで」「Slack 同期して」「sync して」 | connector.sync |

エコシステム共通 dev skill（drive / lint / commit / ship / pr / review 等）は `@ozzylabs/skills` 由来（名前空間 disjoint）で、suasor 開発に使う project skill として host dir に commit 済み（[ADR-0035](../adr/0035-project-skills-vendor-dev-skills.md)・更新は [dev-skills-refresh.md](dev-skills-refresh.md)）。

## インストール

SSOT（本ディレクトリ）はパッケージに同梱され、`suasor skills install` でエージェントの skill ディレクトリに展開する（[ADR-0008](../adr/0008-assistant-skills.md)・[docs/design/cli.md](../design/cli.md)）。

```bash
suasor skills install                 # カレントプロジェクトの .claude/skills/ + .agents/skills/ へ展開
suasor skills install --scope claude  # Claude Code（.claude/skills/）のみ
suasor skills install --scope agents  # Codex / Copilot / Gemini（.agents/skills/）のみ
suasor skills install --host /path/to/project   # 展開先プロジェクトを指定
suasor skills install --dry-run       # 書き込まず差分だけ確認
suasor skills list                    # 各 skill の状態（installed / missing / modified）
suasor skills list --format=detailed  # 状態 + category + read/write 境界を併記
suasor skills list --json             # 機械可読（SkillStatus[]）
suasor skills search <kw>             # name / description / category / triggers 横断検索
suasor skills info <name>             # 単一 skill の category / 境界 / triggers / pairs / MCP tools
```

展開は冪等で、内容一致は `unchanged`・欠落は `created`・差分は SSOT 内容で `updated` に上書きする。`suasor init` は本コマンドを案内するのみで自動展開はしない。

### host dir の扱い（ADR-0035）

[ADR-0035](../adr/0035-project-skills-vendor-dev-skills.md) で in-repo dogfood-commit は廃止した。host dir（`.claude/skills/` / `.agents/skills/`）の扱いは次の 2 系統に分かれる:

- **assistant skill の mirror** — `docs/skills/` SSOT のローカル install 物。**commit しない**（`.gitignore` 済み）。各開発者が必要に応じ `suasor skills install` で展開する。install の正しさは `tests/skills/install.test.ts`（synthetic SSOT 上の `installSkills` / `detectDrift`）が担保する。
- **エコシステム共通 dev skill（drive / lint / commit 等）** — suasor 開発に使う **project skill として commit 済み**。更新手順は [dev-skills-refresh.md](dev-skills-refresh.md) を参照。
