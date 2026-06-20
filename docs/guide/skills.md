# アシスタント skill 利用ガイド

Suasor は 26 個のアシスタント skill を同梱する（[ADR-0008](../adr/0008-assistant-skills.md)）。自然文で頼むと該当 skill が発火し、Suasor MCP の read / write tool を組み合わせて「次にやること」「今日のまとめ」「この資料から task 抽出」などを返す。本ガイドは **install → 起動 → 確認 → トラブルシュート** を 1 本にまとめる。

> skill の責務一覧（catalog）は [docs/skills/README.md](../skills/README.md)。frontmatter の機械可読フィールド仕様は [ADR-0032](../adr/0032-skill-frontmatter-schema.md)。CLI verb の一覧は [docs/design/cli.md](../design/cli.md)。

## 1. install（展開）

SSOT は `docs/skills/<name>/SKILL.md`（パッケージ同梱）。`suasor skills install` で各エージェントの skill ディレクトリに展開する。

```bash
suasor skills install                  # .claude/skills/ + .agents/skills/ へ展開（カレントプロジェクト）
suasor skills install --scope claude   # Claude Code（.claude/skills/）のみ
suasor skills install --scope agents   # Codex / Copilot / Gemini（.agents/skills/）のみ
suasor skills install --host /path/to/project   # 展開先プロジェクトを指定
suasor skills install --dry-run        # 書き込まず差分（created / updated / unchanged）だけ確認
```

展開は冪等。内容一致は `unchanged`・欠落は `created`・差分は SSOT 内容で `updated`。`suasor init` は本コマンドを案内するのみで自動展開はしない。

## 2. 起動（自然文トリガ）

skill は **専用コマンドではなく、エージェントへの自然文依頼で発火**する。各 skill の frontmatter `description` / `triggers` がトリガ判定の入力になる。例:

| 言いかた | 発火する skill | 種別 |
|---|---|---|
| 「次に何やる?」「優先度高いのは?」 | `next-actions` | read |
| 「今日のまとめ」「最近どう」 | `personal-brief` | read |
| 「あの資料どこ」「<語>含むファイル」 | `find-document` | read |
| 「この資料から task 抽出」 | `source-extract` | write（HITL） |
| 「返信案考えて」「下書き作って」 | `reply-draft` | write（HITL） |

read 系（自律 OK・17）はエージェントが自律実行してよい。write 系（HITL・9）は候補生成までで、**適用はユーザー承認が必須**（auto-apply 経路は無い、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

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
mcp (read):  task.list, recall.search, slack.demand.list, commitment.list
description: 「次に何をする?」「やること教えて」…
```

`category` の値集合（閉じた enum）: `brief` / `retrieval` / `meeting` / `decision` / `review` / `draft` / `triage` / `commitment` / `task` / `graph` / `identity` / `planning`（[ADR-0032](../adr/0032-skill-frontmatter-schema.md)）。

## 4. トラブルシュート

### skill が発火しない

- `suasor skills list` で当該 skill が `installed` か確認する。`missing` なら `suasor skills install` で展開する。
- 起動はあくまで自然文トリガ。`suasor skills info <name>` で `triggers` を確認し、近い言いかたで頼む。
- Claude Code / Codex 等のホストが skill ディレクトリ（`.claude/skills/` / `.agents/skills/`）を読む設定になっているか確認する。

### `modified` / drift と表示される

mirror（`.claude/skills/` / `.agents/skills/`）が SSOT（`docs/skills/`）と差分がある状態。`suasor skills install` で SSOT 内容に再展開すると `installed` に戻る。リポジトリ内では lefthook の `skills-drift` フック（`scripts/skills-drift.sh`）が pre-commit で mirror と SSOT の byte 一致を検査する（[ADR-0008](../adr/0008-assistant-skills.md)）。

### read / write 境界が分からない

`suasor skills info <name>` の `boundary` 行を見る。`read (autonomous)` は自律実行可、`write (HITL)` は候補生成までで適用はユーザー承認が必須（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

### standalone binary で `skills` コマンドが使えない

`skills install` / `list` / `search` / `info` は同梱 `docs/skills` を読むため、バンドル単体実行（`docs/skills` 非同梱）では明示エラーで弾かれる。npm パッケージ経由か repo から実行する。

## 関連

- [ADR-0008](../adr/0008-assistant-skills.md) — アシスタント skill の SSOT / install / drift
- [ADR-0032](../adr/0032-skill-frontmatter-schema.md) — frontmatter 機械可読フィールド + `skills search` / `info`
- [ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) — read 自律 / write HITL 境界
- [docs/skills/README.md](../skills/README.md) — skill catalog（全 26 件の責務と発火例）
- [docs/design/cli.md](../design/cli.md) — CLI verb 一覧
