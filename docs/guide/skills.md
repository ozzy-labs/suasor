# アシスタント skill 利用ガイド

Suasor はアシスタント skill 群を同梱する（[ADR-0008](../adr/0008-assistant-skills.md)）。自然文で頼むと該当 skill が発火し、Suasor MCP の read / write tool を組み合わせて「次にやること」「今日のまとめ」「この資料から task 抽出」などを返す。本ガイドは **install → 起動 → 確認 → トラブルシュート** を 1 本にまとめる。

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
suasor skills prune                    # catalog から消えた旧 skill の mirror（orphan）を削除
suasor skills prune --dry-run          # 削除対象を確認するだけ
```

**既定は user scope**（`$HOME` 配下）。skill は「どのプロジェクトで作業していても使いたい」ものなので、1 回入れれば全プロジェクトで発火する user scope を既定にしている。特定プロジェクトにだけ置きたい場合のみ `--project`（または `--host <path>`）を使う。

展開は冪等。内容一致は `unchanged`・欠落は `created`・差分は SSOT 内容で `updated`。`suasor init` は本コマンドを案内するのみで自動展開はしない。

**install は上書きするだけで削除はしない**。catalog から消えた・改名された skill（[ADR-0046](../adr/0046-agent-surface-contraction.md) の収縮など）の mirror はアップグレード後も残り、現行 skill とトリガが衝突したり、存在しない MCP tool を指示したりする（[Issue #556](https://github.com/ozzy-labs/suasor/issues/556)）。この残骸は `skills list` が `orphan` として報告し、install 実行時にも stderr へ 1 行警告する。削除は opt-in の `suasor skills prune` で行う（`--dry-run` で削除対象だけ確認できる）。**対象になるのは suasor が書いたと証明できる mirror のみ** — stamp に記録された名前と既知の退役名だけを見るため、同じディレクトリに同居するエコシステム dev skill（`@ozzylabs/skills` の drive / commit 等）や手置きの skill には触れない。唯一の例外は**既知の退役名と同名の手置き skill**（例: 自作の `research`）で、stamp の無い旧 install と区別できないため候補に載る — 消したくない同名 skill がある場合は `--dry-run` で対象を確認してから実行する。

install 時、展開先 skill ディレクトリの直下に `.suasor-skills.json`（展開した suasor の version・時刻・書き込んだ skill 名の一覧）を残す。mirror 自体は SSOT とバイト一致を保つ必要がある（drift 検出）ため、stamp は mirror の**外**に置く。version が現在の suasor と食い違うと `suasor skills list` と `suasor mcp serve` の起動時に stderr へ 1 行だけ再 install を促す（`list` の結果自体は汚さない）。skill 名の一覧は orphan 検出の所有権記録で、将来 catalog から skill が消えたときに「suasor が入れたが今は無い」を機械的に判定するために使う。

## 2. 起動（自然文トリガ）

skill は **専用コマンドではなく、エージェントへの自然文依頼で発火**する。各 skill の frontmatter `description` / `triggers` がトリガ判定の入力になる。例:

| 言いかた | 発火する skill | 種別 |
|---|---|---|
| 「次に何やる?」「優先度高いのは?」 | `next-actions` | read |
| 「今日のまとめ」「週次の棚卸し」「上司向け週次報告」 | `brief` | read |
| 「あの資料どこ」「<語> について調べて」 | `find` | read |
| 「この設計書レビューして」「前回から何が変わった」 | `source-review` | read |
| 「この資料から task 抽出」 | `source-extract` | write（HITL） |
| 「返信案考えて」「下書き作って」 | `reply-draft` | write（HITL） |

read 系（自律 OK）はエージェントが自律実行してよい。write 系（HITL）は候補生成までで、**適用はユーザー承認が必須**（auto-apply 経路は無い、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

## 3. 確認（list / search / info）

どの skill があるか・何をするか・どう起動するかは CLI から機械的に確認できる（[ADR-0032](../adr/0032-skill-frontmatter-schema.md)）。

```bash
# 状態一覧（installed / missing / modified / orphan）
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

mirror（`.claude/skills/` / `.agents/skills/`）が SSOT（`docs/skills/`）と差分がある状態。`suasor skills install` で SSOT 内容に再展開すると `installed` に戻る。なお [ADR-0035](../adr/0035-project-skills-vendor-dev-skills.md) で in-repo の mirror commit と `skills-drift` フックは廃止された。**host dir（`.claude/skills/` / `.agents/skills/`）配下は現在すべてローカル install 物で、commit されるものは無い** — dev skill の project-scope vendoring も 2026-07-04 に撤回され user-scope install へ移行した。

### `orphan` と表示される

catalog がもう同梱していない skill の mirror が host dir に残っている状態（install は上書きするだけで削除しないため、[ADR-0046](../adr/0046-agent-surface-contraction.md) で改名・統合された旧 skill が残る。[Issue #556](https://github.com/ozzy-labs/suasor/issues/556)）。放置すると旧 skill が現行 skill とトリガ競合し、改名前の MCP tool（例: `recall.search`）を呼んで失敗する。`suasor skills prune` で削除する（`--dry-run` で対象確認）。suasor が書いた記録のある mirror だけが対象で、同居する dev skill 等には触れない。

### read / write 境界が分からない

`suasor skills info <name>` の `boundary` 行を見る。`read (autonomous)` は自律実行可、`write (HITL)` は候補生成までで適用はユーザー承認が必須（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

### standalone binary の skill

standalone binary でも `skills install` / `list` / `search` / `info` は **npm / Docker と同じく全 skill で動く**（Issue #445）。`bun build --compile` は module graph が静的参照する内容しか埋め込まないため、SSOT は `src/skills/embedded.ts`（生成物・commit 済み）としてソースに inline してある。`docs/skills/` が実在する repo / npm 実行ではそちらをディスクから読み、無ければ埋め込みへフォールバックする。

SSOT を編集したら `node scripts/generate-embedded-skills.mjs` で再生成する（忘れると `tests/skills/embedded.test.ts` の drift テストが落ちる）。

## 関連

- [ADR-0008](../adr/0008-assistant-skills.md) — アシスタント skill の SSOT / install / drift
- [ADR-0032](../adr/0032-skill-frontmatter-schema.md) — frontmatter 機械可読フィールド + `skills search` / `info`
- [ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) — read 自律 / write HITL 境界
- [docs/skills/README.md](../skills/README.md) — skill catalog（各 skill の責務と発火例）
- [docs/design/cli.md](../design/cli.md) — CLI verb 一覧
