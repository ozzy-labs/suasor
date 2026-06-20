# 0032. Skill frontmatter schema (machine-readable fields) + `skills search` / `skills info`

- Status: Accepted
- Date: 2026-06-20
- Deciders: Suasor maintainers
- Related: [ADR-0008](0008-assistant-skills.md)（アシスタント skill catalog・SSOT `docs/skills/<name>/SKILL.md`・`suasor skills install` 展開）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP agent boundary・read 自律 / write HITL）, [ADR-0006](0006-ml-delegation.md)（ML 委譲境界）
- Tracks: #199 / Epic #185 / Phase 4

## Context

アシスタント skill（[ADR-0008](0008-assistant-skills.md)）の発見性が弱い。

- `suasor skills list` は **インストール状態（installed / missing / modified）しか出さない**（`src/cli/commands/skills.ts`）。「その skill が何をするか / どう起動するか / read か write か」が CLI から分からない。
- frontmatter は `name` と散文の `description` だけで、host（Claude Code 等）や CLI が **機械的に扱えるフィールドが無い**。read-only か write（HITL）か、どのカテゴリか、どんな自然文で発火するか、対になる skill は何か、が構造化されていない。
- install 後の「どう起動するか / 動いているか確認する方法 / 直し方」のガイドが無い（`docs/skills/README.md` は catalog 一覧のみ）。

これらは [ADR-0008](0008-assistant-skills.md) の不変条件（SSOT は `docs/skills/<name>/SKILL.md`・mirror は drift フックで byte 一致を保証・read 自律 / write HITL）を**崩さずに**解消したい。とりわけ frontmatter 拡張は、既に展開済みの mirror やパースしている host を壊さない **後方互換**でなければならない。

## Decision

**skill frontmatter に後方互換な機械可読フィールドを追加し、それを検証する Zod スキーマ（`src/skills/frontmatter.ts`）と、`suasor skills search <kw>` / `suasor skills info <name>` / `suasor skills list --format=detailed` を新設する。**

### (a) frontmatter スキーマ（後方互換拡張）

既存の `name`（必須）/ `description`（必須・自然文トリガ）は維持し、以下を **任意フィールド**として追加する:

| field | 型 | 必須 | 意味 |
|---|---|---|---|
| `name` | string | ✅ | skill 名（ディレクトリ名と一致） |
| `description` | string | ✅ | 自然文トリガ（既存・散文。host の発火判定に使う） |
| `readOnly` | boolean | （実質必須） | read 系（自律 OK）か write 系（HITL・auto-apply なし、[ADR-0004](0004-mcp-agent-boundary-and-hitl.md)）か |
| `category` | string | （実質必須） | 機能カテゴリ（`brief` / `retrieval` / `meeting` / `decision` / `review` / `draft` / `triage` / `commitment` / `task` / `graph` / `identity` / `planning`） |
| `triggers` | string[] | 任意 | 構造化した発火例（`description` の散文を機械可読に分解。`skills search` の一致対象） |
| `pairs` | string[] | 任意 | 対になる skill 名（例: `personal-brief` ↔ `external-brief`） |
| `mcp_tools_read` | string[] | 任意 | この skill が叩く read 系 MCP tool（例: `task.list`） |
| `mcp_tools_write` | string[] | 任意 | この skill が叩く write 系 MCP tool（HITL・例: `propose.apply`） |

**後方互換の担保:**

- スキーマは **未知フィールドを許容**（`.passthrough()` 相当）し、追加フィールドが欠落していても **パースは失敗しない**。`name` / `description` だけの旧 frontmatter は引き続き valid。
- `readOnly` / `category` は型としては optional だが、**全 26 skill に付与する**ことを validator テストで担保する（下記 (c)）。「実質必須」とはこの意味。新規 skill 追加時に欠落すれば validator テストが落ちる。
- mirror（`.claude/skills/` / `.agents/skills/`）は SSOT を byte コピーするだけなので（[ADR-0008](0008-assistant-skills.md)・`scripts/skills-drift.sh`）、frontmatter 拡張は drift フックと自動的に整合する。**SSOT を編集したら `suasor skills install` で mirror を再生成する**運用は不変。

### (b) `category` の値集合と `pairs` の整合

- `category` は上表の閉じた集合（enum 相当）。新カテゴリを足すときは本 ADR とスキーマを同時に更新する。
- `pairs` は **双方向で一致**させる（`a.pairs` に `b` があれば `b.pairs` に `a` がある）。validator テストで対称性を検証する。
- `readOnly` の真偽は `docs/skills/README.md` の Read 系（17）/ HITL write 系（9）分類を SSOT とし、frontmatter に転記する。

### (c) frontmatter validator（テスト + drift 連携可能）

`src/skills/frontmatter.ts` が SSOT:

- `parseFrontmatter(md: string)`: SKILL.md 先頭の YAML frontmatter（`---` 区切り）を取り出して JS object に変換する純粋関数（依存は最小限の自前パーサ。`node:fs` 以外の重い依存を足さない、NFR-PRF-1 / [ADR-0008](0008-assistant-skills.md)）。
- `SkillFrontmatter` Zod スキーマ: 上記フィールドを検証。`safeParse` で詳細エラーを返す。
- `loadSkillFrontmatter(skill: BundledSkill)`: catalog の `BundledSkill` から frontmatter を読んでパース + 検証する。

テスト `tests/skills/frontmatter.test.ts` が:

1. **全 26 SKILL.md がスキーマを通る**（必須 `name` / `description`、`readOnly` boolean、`category` が enum 値）。
2. `name` frontmatter とディレクトリ名が一致する。
3. `pairs` の対称性。
4. mirror（`.claude/skills/` / `.agents/skills/`）の frontmatter が SSOT と一致する（drift と同等の回帰。byte 一致は `scripts/skills-drift.sh` が pre-commit で別途担保）。

### (d) CLI verb

- `suasor skills search <kw>`: `name` / `description` / `triggers` / `category` を横断して部分一致検索し、ヒット skill を `readOnly` / `category` 付きで一覧する。`--json` 対応。
- `suasor skills info <name>`: 単一 skill の `name` / `category` / `readOnly` / `triggers` / `pairs` / `mcp_tools_*` / `description` を整形表示する。`--json` 対応。未知 name はエラー（exit 1）。
- `suasor skills list --format=detailed`: 既存の status 一覧に `category` / `readOnly`（read/write）列を加えた詳細表示。既定 `--format` は従来どおり（`compact`）で **既存出力を壊さない**。`--json` は従来 `SkillStatus[]` を維持。

CLI は import-clean を保つ（frontmatter ロードは `execute` 内で lazy-import、[docs/design/cli.md](../design/cli.md)・NFR-PRF-1）。standalone binary では `docs/skills` が同梱されないため、既存 `skills install` / `list` と同じ `standaloneGate` で弾く。

### (e) 利用ガイド

`docs/guide/skills.md` を新設し、install → 起動（自然文トリガ） → 確認（`skills list` / `info` / `search`）→ トラブルシュート（mirror drift・未発火・read/write 境界）を 1 本にまとめる。`docs/skills/README.md` / `docs/design/cli.md` から相互リンクする。

## Consequences

### Positive

- host / CLI が skill を機械的に扱える（read/write 境界・カテゴリ・発火トリガ・対 skill が構造化される）。
- `skills search` / `info` で発見性が上がり、install 後の起動・確認導線がガイドで埋まる。
- frontmatter 拡張は後方互換（未知フィールド許容・必須 2 フィールド不変）なので、既存 mirror・host パーサ・drift フックを壊さない。
- validator テストが新規 skill 追加時の必須フィールド欠落・カテゴリ逸脱・pair 非対称を回帰で捕まえる。

### Negative / Trade-offs

- 26 skill 全てに frontmatter フィールドを転記する初期コストと、`README.md` の read/write 分類との二重管理（validator が乖離を捕まえるので drift は検知できるが、SSOT が README と frontmatter に分かれる）。
- `category` enum を増やすたびに ADR + スキーマ + 全 skill 見直しが要る（閉じた集合のメンテコスト）。best-effort な発見性向上のためで、過剰に細分化しない方針で抑える。
