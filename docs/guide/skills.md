# アシスタント skill 利用ガイド

Suasor は 32 個のアシスタント skill を同梱する（[ADR-0008](../adr/0008-assistant-skills.md)）。自然文で頼むと該当 skill が発火し、Suasor MCP の read / write tool を組み合わせて「次にやること」「今日のまとめ」「この資料から task 抽出」などを返す。本ガイドは **install → 起動 → 確認 → トラブルシュート** を 1 本にまとめる。

> skill の責務一覧（catalog）は [docs/skills/README.md](../skills/README.md)。frontmatter の機械可読フィールド仕様は [ADR-0032](../adr/0032-skill-frontmatter-schema.md)。CLI verb の一覧は [docs/design/cli.md](../design/cli.md)。

## 1. install（展開）

SSOT は `docs/skills/<name>/SKILL.md`（パッケージ同梱）。`suasor skills install` で各エージェントの skill ディレクトリに展開する。

```bash
suasor skills install                  # ~/.claude/skills/ + ~/.agents/skills/ へ展開（user scope・既定）
suasor skills install --project        # カレントプロジェクトの .claude/skills/ + .agents/skills/ へ展開
suasor skills install --scope claude   # Claude Code（.claude/skills/）のみ
suasor skills install --scope agents   # Codex / Copilot / Gemini（.agents/skills/）のみ
suasor skills install --host /path/to/project   # 展開先を明示指定（--project より優先）
suasor skills install --dry-run        # 書き込まず差分（created / updated / unchanged）だけ確認
```

**既定は user scope**（`$HOME` 配下）。skill は「どのプロジェクトで作業していても使いたい」ものなので、1 回入れれば全プロジェクトで発火する user scope を既定にしている。特定プロジェクトにだけ置きたい場合のみ `--project`（または `--host <path>`）を使う。

展開は冪等。内容一致は `unchanged`・欠落は `created`・差分は SSOT 内容で `updated`。`suasor init` は本コマンドを案内するのみで自動展開はしない。

install 時、展開先 skill ディレクトリの直下に `.suasor-skills.json`（展開した suasor の version と時刻）を残す。mirror 自体は SSOT とバイト一致を保つ必要がある（drift 検出）ため、stamp は mirror の**外**に置く。version が現在の suasor と食い違うと `suasor skills list` と `suasor mcp serve` の起動時に stderr へ 1 行だけ再 install を促す（`list` の結果自体は汚さない）。

## 2. 起動（自然文トリガ）

skill は **専用コマンドではなく、エージェントへの自然文依頼で発火**する。各 skill の frontmatter `description` / `triggers` がトリガ判定の入力になる。例:

| 言いかた | 発火する skill | 種別 |
|---|---|---|
| 「次に何やる?」「優先度高いのは?」 | `next-actions` | read |
| 「今日のまとめ」「最近どう」 | `personal-brief` | read |
| 「あの資料どこ」「<語>含むファイル」 | `find-document` | read |
| 「この資料から task 抽出」 | `source-extract` | write（HITL） |
| 「返信案考えて」「下書き作って」 | `reply-draft` | write（HITL） |

read 系（自律 OK・20）はエージェントが自律実行してよい。write 系（HITL・9）は候補生成までで、**適用はユーザー承認が必須**（auto-apply 経路は無い、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

## 3. 確認（list / search / info）

どの skill があるか・何をするか・どう起動するかは CLI から機械的に確認できる（[ADR-0032](../adr/0032-skill-frontmatter-schema.md)）。

```bash
# 状態一覧（installed / missing / modified）
suasor skills list
suasor skills list --scope claude
suasor skills list --json                      # SkillStatus[]（name / host / state / mirrorPath）

# 状態 + カテゴリ + read/write 境界を併記
suasor skills list --format=detailed

# キーワード横断検索（name / description / category / triggers）
suasor skills search meeting
suasor skills search 引き継ぎ
suasor skills search brief --json

# 単一 skill の詳細（category / 境界 / triggers / pairs / MCP tools / description）
suasor skills info next-actions
suasor skills info reply-draft --json
```

`skills info` の出力例:

```text
name:        next-actions
category:    task
boundary:    read (autonomous)
triggers:
  - 次に何をする?
  - やること教えて
  ...
mcp (read):  priority.list, task.list, search, demand.list, commitment.list
description: 「次に何をする?」「やること教えて」…
```

`category` の値集合（閉じた enum）: `brief` / `retrieval` / `meeting` / `decision` / `review` / `draft` / `triage` / `commitment` / `task` / `graph` / `identity` / `planning`（[ADR-0032](../adr/0032-skill-frontmatter-schema.md)）。

## 4. トラブルシュート

### skill が発火しない

- `suasor skills list` で当該 skill が `installed` か確認する。`missing` なら `suasor skills install` で展開する。
- 起動はあくまで自然文トリガ。`suasor skills info <name>` で `triggers` を確認し、近い言いかたで頼む。
- Claude Code / Codex 等のホストが skill ディレクトリ（`.claude/skills/` / `.agents/skills/`）を読む設定になっているか確認する。

### `modified` / drift と表示される

mirror（`.claude/skills/` / `.agents/skills/`）が SSOT（`docs/skills/`）と差分がある状態。`suasor skills install` で SSOT 内容に再展開すると `installed` に戻る。なお [ADR-0035](../adr/0035-project-skills-vendor-dev-skills.md) で in-repo の mirror commit と `skills-drift` フックは廃止され、assistant mirror は `.gitignore` 済みのローカル install 物になった（commit されない）。host dir に commit されているのは vendored dev skill のみ。

### read / write 境界が分からない

`suasor skills info <name>` の `boundary` 行を見る。`read (autonomous)` は自律実行可、`write (HITL)` は候補生成までで適用はユーザー承認が必須（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

### standalone binary の skill

standalone binary でも `skills install` / `list` / `search` / `info` は **npm / Docker と同じく全 32 skill で動く**（Issue #445）。`bun build --compile` は module graph が静的参照する内容しか埋め込まないため、SSOT は `src/skills/embedded.ts`（生成物・commit 済み）としてソースに inline してある。`docs/skills/` が実在する repo / npm 実行ではそちらをディスクから読み、無ければ埋め込みへフォールバックする。

SSOT を編集したら `node scripts/generate-embedded-skills.mjs` で再生成する（忘れると `tests/skills/embedded.test.ts` の drift テストが落ちる）。

## 関連

- [ADR-0008](../adr/0008-assistant-skills.md) — アシスタント skill の SSOT / install / drift
- [ADR-0032](../adr/0032-skill-frontmatter-schema.md) — frontmatter 機械可読フィールド + `skills search` / `info`
- [ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) — read 自律 / write HITL 境界
- [docs/skills/README.md](../skills/README.md) — skill catalog（全 32 件の責務と発火例）
- [docs/design/cli.md](../design/cli.md) — CLI verb 一覧
