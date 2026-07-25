# Assistant Skills

[ADR-0008](../adr/0008-assistant-skills.md)。自然文トリガのアシスタント skill 群。SSOT は `docs/skills/<name>/SKILL.md`、`suasor skills install` で `.claude/skills/` `.agents/skills/` に展開する。read 系はエージェント自律 OK、write 系は HITL（auto-apply なし、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。install 後の起動・確認・トラブルシュートは [利用ガイド](../guide/skills.md) を参照。

> 本ファイルは catalog（責務と発火条件の一覧）。各 skill の本体は `<name>/SKILL.md`（下表の skill 名からリンク）。frontmatter は `name` / 自然文トリガの `description` に加え、機械可読フィールド（`readOnly` / `category` / `triggers[]` / `pairs[]` / 任意の `mcp_tools_read/write[]`、[ADR-0032](../adr/0032-skill-frontmatter-schema.md)）+ 駆動する MCP tool flow を持つ。`suasor skills search` / `skills info` / `skills list --format=detailed` でこれらを CLI から引ける。

## Read 系（自律 OK・9）

各 skill が叩く完全な MCP tool 一覧は `suasor skills info <name>`（frontmatter の `mcp_tools_*` が SSOT・[ADR-0032](../adr/0032-skill-frontmatter-schema.md)）で引ける。下表の「主な MCP tool」は要約。

> **[ADR-0046](../adr/0046-agent-surface-contraction.md) で 32 → 22 に収縮した。** 同じ意図の skill を 1 本に畳み、違いは引数（期間・読み手・対象・深さ）に逃がしている。ユーザーは skill 名を知らずに話しかけるので、「今週どうなってる」の一言で 5 本が競合する状態が問題だった。**read / write の承認境界は跨いでいない**（跨ぐと HITL が壊れる）ため、畳まれたのは read 系のみ。

| skill | 発火例 | 主な MCP tool |
|---|---|---|
| [`brief`](brief/SKILL.md) | 「今日のまとめ」「前回以降の差分」「週次の棚卸し」「上司向け週次報告」「今どれくらい溜まってる」 | brief / priority.list / task.list / decision.list / inbox.list / demand.list / commitment.list |
| [`next-actions`](next-actions/SKILL.md) | 「次に何やる」「優先度高いのは」 | priority.list / task.list / search |
| [`find`](find/SKILL.md) | 「あの資料どこ」「`<X>` について調べて」「網羅的に」 | search / graph.related / brief |
| [`source-review`](source-review/SKILL.md) | 「この設計書レビューして」「この PR レビューして」「前回から何が変わった」 | source.get / source.history / search / graph.related |
| [`meeting`](meeting/SKILL.md) | 「来週の会議準備」「あの会議から何が実装されたか」 | source.list(calendar) / search / graph.related / task.list |
| [`decisions`](decisions/SKILL.md) | 「今月の決定」「あの決定はなぜ」 | decision.list / graph.related / search |
| [`draft`](draft/SKILL.md) | 「リリース告知文書いて」「引き継ぎ書作って」 | search / decision.list / task.list（text-only・persist なし） |
| [`commitment-chase`](commitment-chase/SKILL.md) | 「催促して」「相手の約束で期限切れ」 | commitment.list(owed_to_me) + graph.related / source.get（text-only・persist なし） |
| [`provenance-trace`](provenance-trace/SKILL.md) | 「この task の出どころ」「由来を辿って」 | graph.related / graph.expand(direction=in) / source.get |

### 畳んだ対応（移行表）

| 旧 skill | 新 skill | 引数 |
|---|---|---|
| `personal-brief` / `catchup` / `weekly-review` / `external-brief` / `health-check` | `brief` | `period` / `audience` / `focus` |
| `doc-review` / `pr-review` / `doc-diff` | `source-review` | `target` |
| `find-document` / `research` | `find` | `depth` |
| `meeting-prep` / `action-item-status` | `meeting` | `phase` |
| `decision-log` / `decision-rationale` | `decisions` | `mode` |
| `announcement-draft` / `handoff-draft` | `draft` | `kind` |

## HITL write 系（人の承認で適用・13）

| skill | 発火例 | 主な MCP tool |
|---|---|---|
| [`reply-draft`](reply-draft/SKILL.md) | 「返信案考えて」「下書き作って」 | propose.generate(reply_draft) → propose.apply / draft.export |
| [`slack-triage`](slack-triage/SKILL.md) | 「Slack の未処理を捌いて」「mention/DM まとめて」 | demand.list(source=slack) → inbox.add / source.get → propose.generate(source_extract) → propose.apply / demand.mark |
| [`inbox-triage`](inbox-triage/SKILL.md) | 「受信箱整理して」「未処理捌いて」 | inbox.list → propose.generate(inbox_triage) → task.create / propose.apply |
| [`source-extract`](source-extract/SKILL.md) | 「この資料からタスク抽出」 | source.get → propose.generate(source_extract) → propose.apply |
| [`meeting-followup`](meeting-followup/SKILL.md) | 「会議後のaction items」「議事録からタスク」 | source.list(calendar) → propose.generate(meeting_followup) → propose.apply |
| [`commitment-review`](commitment-review/SKILL.md) | 「約束をスキャンして」「貸し借り確認」 | propose.generate(commitment_scan) → propose.apply / commitment.list → resolve / dismiss / reopen |
| [`proposal-review`](proposal-review/SKILL.md) | 「保留中の提案を確認」「pending を捌いて」 | propose.list(pending) → propose.apply / propose.reject / propose.batch |
| [`person-cleanup`](person-cleanup/SKILL.md) | 「同一人物をまとめて」「people を整理」 | person.list → person.merge / person.split |
| [`task-update`](task-update/SKILL.md) | 「これ終わった」「完了にして」「task を進行中に」 | task.list → task.update |
| [`task-publish`](task-publish/SKILL.md) | 「GitHub に起票して」「Jira を完了に」「issue にコメント」 | task.list → task.publish / task.act |
| [`plan-draft`](plan-draft/SKILL.md) | 「これを分解して」「計画に落として」 | source.get / search（mode=semantic） → propose.generate(source_extract) → propose.apply / draft.export |
| [`source-forget`](source-forget/SKILL.md) | 「あの誤取り込みを消して」「この source を忘れて」 | search / source.list → source.forget |
| [`sync-now`](sync-now/SKILL.md) | 「最新を取り込んで」「Slack 同期して」「sync して」 | connector.sync |

エコシステム共通 dev skill（drive / lint / commit / ship / pr / review 等）は `@ozzylabs/skills` 由来（名前空間 disjoint）。**user-scope install（`npx @ozzylabs/skills install`）で利用する** — [ADR-0035](../adr/0035-project-skills-vendor-dev-skills.md) の project-scope vendoring は 2026-07-04 に一部撤回された（当時の re-vendor 手順は [dev-skills-refresh.md](dev-skills-refresh.md) に歴史的記録として残る）。

## インストール

SSOT（本ディレクトリ）はパッケージに同梱され、`suasor skills install` でエージェントの skill ディレクトリに展開する（[ADR-0008](../adr/0008-assistant-skills.md)・[docs/design/cli.md](../design/cli.md)）。

```bash
suasor skills install                 # ~/.claude/skills/ + ~/.agents/skills/ へ展開（user scope・既定）
suasor skills install --project       # カレントプロジェクトの .claude/skills/ + .agents/skills/ へ展開
suasor skills install --scope claude  # Claude Code（.claude/skills/）のみ
suasor skills install --scope agents  # Codex / Copilot / Gemini（.agents/skills/）のみ
suasor skills install --host /path/to/project   # 展開先を明示指定（--project より優先）
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
- **エコシステム共通 dev skill（drive / lint / commit 等）** — `@ozzylabs/skills` 由来。**user-scope install（`npx @ozzylabs/skills install`）で利用**する（以前は project-scope に commit していたが撤回・[ADR-0035](../adr/0035-project-skills-vendor-dev-skills.md) の一部撤回注記を参照）。
