# CLI

clipanion ベース。lazy import で cold start を軽く保つ（[ADR-0001](../adr/0001-typescript-bun-stack.md) / NFR-PRF-1）。

## コマンド（暫定）

```bash
suasor init                       # 設定 + DB 初期化 + skills install
suasor db migrate                 # projection schema 適用
suasor projections rebuild        # event replay で projection 再構築
suasor <connector> sync           # 取り込み（github / slack / ... ）
suasor search <query>             # FTS 検索
suasor mcp serve                  # MCP server（stdio）起動
suasor skills install [--scope]   # アシスタント skill 展開
suasor skills list
```

## 規約

- 各 subcommand は関数内 lazy import で重い依存を遅延ロード
- 長時間コマンド（sync / rebuild）は TTY 時に進捗表示（`--progress` / env で上書き）
- `python -m` 相当は不要（Bun 実行 / 単一バイナリ）。`suasor --version` は entry から
- 詳細フラグは実装 PR で確定
