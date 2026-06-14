# CLI

clipanion ベース。lazy import で cold start を軽く保つ（[ADR-0001](../adr/0001-typescript-bun-stack.md) / NFR-PRF-1）。

## コマンド

```bash
suasor init [--force]                  # 設定 + DB 初期化（skills install は別コマンド）
suasor db migrate [--vec]              # projection schema 適用（idempotent）
suasor projections rebuild             # event replay で projection 再構築
suasor <connector> sync [--full] [--json]  # 取り込み（github 稼働 / slack 等は後続 Issue）
suasor search [--limit N] [--json] <query>  # FTS 検索
suasor mcp serve                       # MCP server（stdio）起動（read tools）
suasor skills install [--scope S] [--host DIR] [--dry-run]  # アシスタント skill 展開
suasor skills list [--scope S] [--host DIR] [--json]        # アシスタント skill 状態一覧
suasor --version                       # バージョン出力
```

実装状況: `init` / `db migrate` / `projections rebuild` / `search` / `github sync` / `mcp serve`（read tools・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）/ `skills install` / `skills list`（アシスタント skill 展開・状態確認、[ADR-0008](../adr/0008-assistant-skills.md)）は稼働。
`<connector> sync` は connector registry から 1 connector = 1 command で派生する（[ADR-0007](../adr/0007-connector-contract.md)）。
GitHub 以外の connector（slack / Microsoft Graph / Google / Box / Web）は後続 Issue（#7–#12）。

## フラグ（確定）

| コマンド | フラグ | 既定 | 意味 |
|---|---|---|---|
| `init` | `--force` | false | 既存 `config.toml` を default テンプレートで上書きする |
| `db migrate` | `--vec` / `--no-vec` | true | sqlite-vec の vec0 substrate を作る／作らない |
| `search` | `--limit N` | 20 | 返す hit の最大数（正の整数。非正値は error） |
| `search` | `--json` | false | 人間可読リストの代わりに `SearchResult`（hits + strategy）を JSON で出力 |
| `<connector> sync` | `--full` | false | 保存済み cursor を無視して全件再スキャン |
| `<connector> sync` | `--json` | false | 件数 + cursor（`SyncOutcome`）を JSON で出力 |
| `skills install` | `--scope S` | all | 展開先 `claude`（`.claude/skills/`） \| `agents`（`.agents/skills/`） \| `all` |
| `skills install` | `--host DIR` | cwd | 展開先のベースディレクトリ（プロジェクトルート） |
| `skills install` | `--dry-run` | false | 書き込まず変更内容（created / updated / unchanged）だけ表示 |
| `skills list` | `--scope S` | all | 状態を確認する展開先 |
| `skills list` | `--host DIR` | cwd | 状態を確認するベースディレクトリ |
| `skills list` | `--json` | false | 人間可読リストの代わりに `SkillStatus[]`（name / host / state / mirrorPath）を JSON で出力 |

- `search <query>` は FTS-first（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）。trigram FTS5 を既定経路とし、3-gram に満たない短クエリ（日本語の 1–2 文字等）は LIKE substring fallback に切り替わる（[retrieval](retrieval.md)）。サービス本体は `src/retrieval/`
- `<connector> sync` は `[embedding].backend` 有効時、新規 / 本文変更 source を埋め込んで vec0 に populate する（`SyncOutcome.embedded`、人間可読出力では `… , N embedded`）。embedding は best-effort でサイドカー失敗は warning（stderr）に留め取り込みは成功する（[embedding setup](../guide/embedding.md) / [retrieval](retrieval.md)）
- `skills install` は SSOT `docs/skills/<name>/SKILL.md`（パッケージ同梱）を `<host>/.claude/skills/<name>/SKILL.md` / `<host>/.agents/skills/<name>/SKILL.md` に展開する（[ADR-0008](../adr/0008-assistant-skills.md)）。冪等で、内容一致は `unchanged`・欠落は `created`・差分は SSOT で `updated`。エコシステム共通 dev skill（`@ozzylabs/skills`）は名前空間 disjoint で touch しない。サービス本体は `src/skills/`
- `skills list` は host dir ごとに各 skill を `installed`（SSOT と一致）/ `missing`（未展開）/ `modified`（展開済みだが SSOT と差分）で報告する。in-repo dogfood の mirror（`.claude/skills/` / `.agents/skills/`）と SSOT の同期は lefthook の `skills-drift` フック（`scripts/skills-drift.sh`）が pre-commit で検査する
- 長時間コマンド（sync / rebuild）の TTY 進捗表示（`--progress` / env 上書き）は connector 実装 Issue で確定

## 規約

- 各 subcommand は `execute` 内 lazy import で重い依存（DB 層 / config loader / connector）を遅延ロードする。
  registration（command クラスの登録）だけが eager。command module の top-level import は clipanion + 標準
  ライブラリに限定し、`tests/cli/lazy-import.test.ts` がこの discipline を静的・動的の両面で検証する
- `python -m` 相当は不要（Bun 実行 / 単一バイナリ）。`suasor --version` は entry の `binaryVersion`（`src/version.ts`）から
