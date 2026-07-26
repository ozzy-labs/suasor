# CLAUDE.md

共通方針は [AGENTS.md](AGENTS.md) を参照（**アーキテクチャ不変条件**・**spec-driven 開発プロセス**・tech stack・検証コマンドはそちらが正本）。以下は Claude Code 固有の設定。

## 基本ルール

- ユーザーへの確認には `AskUserQuestion` を使用する
- 実装・レビュー時は AGENTS.md の「アーキテクチャ不変条件」（event-sourced / local-first / MCP+HITL / FTS-first / **ML 委譲** / connector 契約）を崩さない。詳細は [docs/adr/](docs/adr/)
- ドキュメント先行・全変更 Issue+PR（squash / main 直 push 禁止）

## Skills

- **アシスタント skill（Suasor 同梱・22 件）** — `brief` / `next-actions` / `find` / `meeting` 等。SSOT は [`docs/skills/`](docs/skills/)（[ADR-0008](docs/adr/0008-assistant-skills.md)）、`suasor skills install` で `.claude/skills/` `.agents/skills/` に展開。**展開された mirror は commit しない（`.gitignore` 済みのローカル install 物。[ADR-0035](docs/adr/0035-project-skills-vendor-dev-skills.md)）**。read 系は自律 OK、write 系は HITL（auto-apply なし）
- **エコシステム共通 dev skill** — `@ozzylabs/skills` 由来（drive / commit / review 等）。**user-scope install（`npx @ozzylabs/skills install`）で利用**する。以前は project-scope に commit していたが撤回した（[ADR-0035](docs/adr/0035-project-skills-vendor-dev-skills.md) の一部撤回注記を参照）

## Skills の共通ルール

- スキル完了時のネクストアクション提案には `AskUserQuestion` を使用する
- ネクストアクションはユーザーの確認なく実行しない
