# CLAUDE.md

共通方針は [AGENTS.md](AGENTS.md) を参照（**アーキテクチャ不変条件**・**spec-driven 開発プロセス**・tech stack・検証コマンドはそちらが正本）。以下は Claude Code 固有の設定。

## 基本ルール

- ユーザーへの確認には `AskUserQuestion` を使用する
- 実装・レビュー時は AGENTS.md の「アーキテクチャ不変条件」（event-sourced / local-first / MCP+HITL / FTS-first / **ML 委譲** / connector 契約）を崩さない。詳細は [docs/adr/](docs/adr/)
- ドキュメント先行・全変更 Issue+PR（squash / main 直 push 禁止）

## Skills

スキルは 2 系統に分かれる:

- **アシスタント skill（Suasor 同梱・32 件）** — `personal-brief` / `next-actions` / `find-document` / `research` 等。SSOT は [`docs/skills/`](docs/skills/)（[ADR-0008](docs/adr/0008-assistant-skills.md)）、`suasor skills install` で `.claude/skills/` `.agents/skills/` に展開。**展開された mirror は commit しない（`.gitignore` 済みのローカル install 物。[ADR-0035](docs/adr/0035-project-skills-vendor-dev-skills.md)）**。read 系は自律 OK、write 系は HITL（auto-apply なし）
- **エコシステム共通 dev skill** — `@ozzylabs/skills` 由来。suasor 開発に使う **project skill として `.claude/skills/` `.agents/skills/` に commit 済み**（名前空間 disjoint、[ADR-0035](docs/adr/0035-project-skills-vendor-dev-skills.md)。更新は [docs/skills/dev-skills-refresh.md](docs/skills/dev-skills-refresh.md)）:
  - `/implement` — Issue または指示をもとに、ブランチ作成・実装
  - `/lint` — 全リンターを自動修正付きで実行
  - `/test` — ビルド・テスト・型チェックを実行
  - `/commit` — 変更をステージし、Conventional Commits でコミット
  - `/pr` — 変更を push し、PR を作成・更新
  - `/review` — コード変更や PR をレビュー
  - `/ship` — lint・コミット・PR 作成を一括実行
  - `/drive` — implement + ship + review loop（Issue から merge-ready な PR まで自律駆動）

## Skills の共通ルール

- スキル完了時のネクストアクション提案には `AskUserQuestion` を使用する
- ネクストアクションはユーザーの確認なく実行しない
