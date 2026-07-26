# 0008. Assistant skills

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

> **Amended by [ADR-0035](0035-project-skills-vendor-dev-skills.md):** in-repo の dogfood-commit（mirror を
> `.claude/skills/` / `.agents/skills/` に commit）と `skills-drift.sh` を廃止し、host dir は project skill
> （vendored dev skill）の置き場に再定義した。assistant mirror は `.gitignore` 化（ローカル install のみ）。
> 本 ADR の「アシスタント skill を提供し SSOT を `docs/skills/` に置く」中核判断は維持。
>
> **Amended by [Issue #445](https://github.com/ozzy-labs/suasor/issues/445):** ① 配信の既定スコープを
> **user scope（`$HOME`）** にした（`--project` / `--host` で従来のプロジェクトスコープ）。② standalone binary
> 向けに catalog を `src/skills/embedded.ts`（生成物・commit 済み）としてソースへ inline し、binary でも
> skills 系 verb が全て動くようにした（`docs/skills/` が解決できればディスク優先・無ければ埋め込み）。
> ③ install 時に `.suasor-skills.json` stamp を mirror の外に残し、version 不一致を `skills list` /
> `mcp serve` が stderr で 1 行通知する。
>
> **Amended by [Issue #548](https://github.com/ozzy-labs/suasor/issues/548):** `docs/skills/` の外を指す
> リンクを**絶対 URL**（`REPO_BLOB_BASE_URL` = `docsUrl()` と同じ prefix）に統一した。詳細は
> 下記「リンクの形式（Issue #548）」。mirror の **byte 一致**（SSOT == mirror）は維持している。

## Context

ユーザーは「今日のまとめ」「次にやること」「この資料からタスク抽出」のような自然文で Suasor に依頼する。これらをエージェントホスト上の **skill**（自然文トリガ）として提供し、Suasor の MCP tool を組み合わせて応答させたい。

## Decision

Suasor は **アシスタント skill 群（初期 15 想定）** を提供する:

- **SSOT は `docs/skills/<name>/SKILL.md`**。発火条件は自然文（skill description）で表現
- 配信は **Suasor パッケージ同梱 + `suasor skills install`**（既定は `~/.claude/skills/` / `~/.agents/skills/`＝user scope、`--project` でプロジェクト直下に展開）。展開された mirror は commit しない（[ADR-0035](0035-project-skills-vendor-dev-skills.md) で `.gitignore` 化したローカル install 物。当初の dogfood-commit 方針は撤回）
- skill は read 系（personal-brief / next-actions / find-document / research 等）と **HITL write 系**（reply-draft / inbox-triage / source-extract / meeting-followup 等）に分かれ、write は [ADR-0004](0004-mcp-agent-boundary-and-hitl.md) の HITL 境界に従う（auto-apply なし）
- エコシステム共通 dev skill（drive / lint / commit 等）は `@ozzylabs/skills` 経由で別供給（名前空間 disjoint）

具体的な 15 skill の責務マップ・MCP tool 依存・pair 構造は `docs/design/` と各 `SKILL.md` で定義する。

### リンクの形式（Issue #548）

`docs/skills/` は**リポジトリの残りを連れずに配られる**（`package.json` の `files` に載る同梱物、`src/skills/embedded.ts` としてバイナリに inline、`suasor skills install` で host dir へ複製）。読み手が実際に開くのは配布後の本文なので、リンクの形式は次で固定する:

- **`docs/skills/` の外を指すリンクは絶対 URL**（`https://github.com/ozzy-labs/suasor/blob/main/<path>` = `src/shared/doc-ref.ts` の `REPO_BLOB_BASE_URL`。CLI が `docsUrl()` で印字する URL と同一 prefix）。`../../adr/0008-assistant-skills.md` はリポジトリ内でだけ解決し、npm パッケージにも binary にも install 済み mirror にも `docs/adr/` は無い（[ADR-0010](0010-distribution.md)）
- **`docs/skills/` の中を指すリンクは相対のまま**（`../<name>/SKILL.md`・`README.md`）。`skills install` は同梱 skill を**全件**展開するので、host dir でも同じ相対パスで解決する。相対のままなら「読んでいるその複製」を指す点でも絶対 URL より正確
- 境界は `scripts/check-doc-links.mjs` が機械的に強制する。同時に、自リポの `blob/main/...` URL は repo path に還元して実在と `#fragment` を検査する（絶対 URL 化で [#543](https://github.com/ozzy-labs/suasor/issues/543) のリンク検査を失わないため）

**install 時に書き換える案は却下した**。mirror が SSOT と byte 一致しなくなり、`skills list` が全件 `modified`（`skillStatuses` / `detectDrift` は文字列一致で判定）になる。加えて、npm パッケージ / binary が `docs/skills/` を**直接**読む経路（`skills info` / mirror を人が開く）は install を経由しないので、書き換えても直らない。

## Consequences

### Positive

- 自然文で Suasor を使える（エージェントが裏で MCP tool を叩く）
- skill が Suasor と一緒に配布・バージョン管理される

### Negative / Trade-offs

- skill SSOT と配布先の同期（install/再生成）の運用が要る
- 絶対 URL は本文を太らせる。実測で catalog 全体 +5.8 KB（97.4 KB → 103.2 KB、+6%）、1 skill あたり平均 +250 B。エージェントが読み込む本文量に直接効くが、リンクが一切機能しない状態と引き換えに受け入れる
- URL は `main` 固定（`docsUrl()` と同じ制約・[#386](https://github.com/ozzy-labs/suasor/issues/386)）。古い version の mirror から辿ると最新の doc に着く

## Alternatives Considered

- skill を外部 preset 配信に一本化 → 却下。Suasor 固有 skill は Suasor と一体で配布・バージョン管理する方が整合
