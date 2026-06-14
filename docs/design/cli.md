# CLI

clipanion ベース。lazy import で cold start を軽く保つ（[ADR-0001](../adr/0001-typescript-bun-stack.md) / NFR-PRF-1）。

## コマンド

```bash
suasor init [--force]                  # 設定 + DB 初期化（+ skills install は後続）
suasor db migrate [--vec]              # projection schema 適用（idempotent）
suasor projections rebuild             # event replay で projection 再構築
suasor <connector> sync                # 取り込み（github / slack / ... 後続 Issue）
suasor search [--limit N] [--json] <query>  # FTS 検索
suasor mcp serve                       # MCP server（stdio）起動（後続 Issue）
suasor skills install [--scope S]      # アシスタント skill 展開（後続 Issue）
suasor skills list                     # アシスタント skill 一覧（後続 Issue）
suasor --version                       # バージョン出力
```

実装状況: `init` / `db migrate` / `projections rebuild` / `search` は稼働。`<connector> sync` /
`mcp serve` / `skills install` / `skills list` は本 Issue で command surface のみ確定し、本体は後続 Issue
（connector=#7–#12 / MCP=[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) / skills=[ADR-0008](../adr/0008-assistant-skills.md)）。

## フラグ（確定）

| コマンド | フラグ | 既定 | 意味 |
|---|---|---|---|
| `init` | `--force` | false | 既存 `config.toml` を default テンプレートで上書きする |
| `db migrate` | `--vec` / `--no-vec` | true | sqlite-vec の vec0 substrate を作る／作らない |
| `search` | `--limit N` | 20 | 返す hit の最大数（正の整数。非正値は error） |
| `search` | `--json` | false | 人間可読リストの代わりに `SearchResult`（hits + strategy）を JSON で出力 |
| `skills install` | `--scope S` | all | 展開先 `claude` \| `agents` \| `all` |

- `search <query>` は FTS-first（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）。trigram FTS5 を既定経路とし、3-gram に満たない短クエリ（日本語の 1–2 文字等）は LIKE substring fallback に切り替わる（[retrieval](retrieval.md)）。サービス本体は `src/retrieval/`
- 長時間コマンド（sync / rebuild）の TTY 進捗表示（`--progress` / env 上書き）は connector 実装 Issue で確定

## 規約

- 各 subcommand は `execute` 内 lazy import で重い依存（DB 層 / config loader / connector）を遅延ロードする。
  registration（command クラスの登録）だけが eager。command module の top-level import は clipanion + 標準
  ライブラリに限定し、`tests/cli/lazy-import.test.ts` がこの discipline を静的・動的の両面で検証する
- `python -m` 相当は不要（Bun 実行 / 単一バイナリ）。`suasor --version` は entry の `binaryVersion`（`src/version.ts`）から
