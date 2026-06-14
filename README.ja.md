# Suasor

**集め、覚え、助言する - 決めるのはあなた。**

Suasor はローカルファーストの AI 秘書です。チャット・メール・カレンダー・ドキュメント・コード・Web に散らばった業務情報をプライベートメモリに集め、あなたと AI エージェントが MCP 経由で検索・要約できるようにします。そして、助言し、返信・タスク・決定を提案します。送信も書き込みも、あなたの承認なく行いません。

[English →](README.md)

## できること

- **集める** — あちこちのツールに散らばった業務情報を、手元のプライベートなストアに 1 か所へ集めます。read 専用で、元のソースに書き戻すことはありません。
- **覚える** — それを検索・参照できる記憶として、あなたのマシン上に保持します。
- **助言する** — MCP 経由で提示・要約し、返信・タスク・決定を提案します。あなたと AI エージェントが引き出し、適用するかはあなたが決めます。あなたの承認なく、送信も書き込みもしません。

## ステータス

開発初期。Suasor は仕様駆動で構築中です。配布は npm（`@ozzylabs/suasor`）・単体の単一バイナリ・Ollama 同梱の Docker イメージを予定しています。

## クイックスタート（暫定）

> 開発初期 — command surface は配線済みですが、一部コマンドは stub です（下記参照）。[Bun](https://bun.sh) 1.1+ が必要です。

```bash
bun install            # 依存インストール
bun run src/index.ts --version

# 初回セットアップ: ~/.config/suasor/config.toml とローカル SQLite ストアを作成。
bun run src/index.ts init

# source 本文の全文検索（FTS5。--json / --limit 利用可）。
bun run src/index.ts search "<query>"

# メンテナンス。
bun run src/index.ts db migrate            # projection schema 適用（idempotent）
bun run src/index.ts projections rebuild   # event log を replay して projection 再構築
```

設定は `~/.config/suasor/`（`SUASOR_CONFIG_DIR` で上書き）に置かれます。`<connector> sync` / `skills install` / `skills list` は CLI に配線済みですが、本体は後続リリースで実装します。コマンド・フラグの一覧は [docs/design/cli.md](docs/design/cli.md) を参照してください。

## エージェントホストと接続する（MCP）

Suasor は記憶を AI エージェントへ [Model Context Protocol](https://modelcontextprotocol.io)（stdio transport）で公開します。この server がエージェント境界です。現在は **read** tool を提供します — `search` / `recall.search` / `source.list`・`source.get` / `task.list`・`decision.list`・`inbox.list` — いずれも副作用なしで read-only annotation 付き（host が auto-approve 可）。write tool は HITL（人の承認）の後ろに置かれます（ADR-0004）。承認なく適用・送信はしません。

```bash
bun run src/index.ts mcp serve   # MCP server を stdio で起動
```

MCP host（Claude Code / Claude Desktop / Codex CLI 等）に登録します。Claude Desktop の場合は `claude_desktop_config.json` に以下を追加します:

```jsonc
{
  "mcpServers": {
    "suasor": {
      "command": "suasor",
      "args": ["mcp", "serve"]
    }
  }
}
```

意味検索（`recall.search`）は embedding backend を有効にするまで `embedding_disabled` シグナルを返すため、host は FTS の `search` へ graceful にフォールバックできます（ADR-0005）。tool スキーマは [docs/design/mcp-surface.md](docs/design/mcp-surface.md) を参照してください。

## ライセンス

MIT
