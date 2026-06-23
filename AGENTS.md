# AGENTS.md

このファイルは AI エージェント向けの共通 instructions です（Codex CLI / Gemini CLI / GitHub Copilot CLI が読み込む。Claude Code は `CLAUDE.md` を併読）。

## 基本方針

- 日本語で応答する
- 推奨案とその理由を提示する
- `.env` ファイルは読み取り・ステージングしない
- 破壊的な Git 操作を避ける

## プロジェクト概要

**Suasor** — *Gathers, remembers, advises - you decide.*

ローカルファーストの AI 秘書。チャット・メール・カレンダー・ドキュメント・コード・Web に散らばった業務情報をあなたの手元のプライベートメモリに集め、あなたと AI エージェントが MCP 経由で検索・要約できるようにする。そして助言し、返信・タスク・決定を提案する。**送信も書き込みも、あなたの承認なく行わない（HITL）**。

## アーキテクチャ不変条件（必読・docs/adr が正本）

実装・レビュー時は以下を絶対に崩さないこと。詳細は `docs/adr/`:

1. **event-sourced** — 追記専用 event store が真実。projection（読みモデル）は replay で再構築可能（[ADR-0002]）
2. **local-first / 外部送信最小化** — 取り込みは read 専用、本文は手元に保持、勝手に外へ出さない（[ADR-0003]）
3. **MCP = エージェント境界 + HITL** — 機能は MCP tool として公開。write 系は人の承認なしに適用しない（[ADR-0004]）
4. **FTS-first retrieval** — 検索の既定は SQLite FTS5。embedding は任意の Ollama サイドカー（無効時は FTS に graceful 劣化）（[ADR-0005]）
5. **ML 委譲（最重要）** — **重い ML をプロセス内で実行しない**。LLM/embedding/OCR/STT は API・ローカルサイドカー（Ollama 等）・小さな言語中立 binding に委譲。`src/` にモデル実体を置くディレクトリを作らない（[ADR-0006]）
6. **connector 契約** — 取り込みは共通 contract 実装（[ADR-0007]）/ **アシスタント skill**（[ADR-0008]）/ **マルチエージェント中立**（[ADR-0009]）/ **配布** npm + Bun 単一バイナリ + Docker(+Ollama)（[ADR-0010]）

[ADR-0002]: docs/adr/0002-event-sourced-architecture.md
[ADR-0003]: docs/adr/0003-local-first-and-content-minimization.md
[ADR-0004]: docs/adr/0004-mcp-agent-boundary-and-hitl.md
[ADR-0005]: docs/adr/0005-fts-first-retrieval-embedding-sidecar.md
[ADR-0006]: docs/adr/0006-ml-delegation.md
[ADR-0007]: docs/adr/0007-connector-contract.md
[ADR-0008]: docs/adr/0008-assistant-skills.md
[ADR-0009]: docs/adr/0009-multi-agent-neutrality.md
[ADR-0010]: docs/adr/0010-distribution.md
[ADR-0035]: docs/adr/0035-project-skills-vendor-dev-skills.md

## 開発プロセス（spec-driven・必読）

- **ドキュメント先行**: `docs/requirements/` → `docs/adr/` → `docs/design/` → ユーザー doc を**実装より先に**確定する
- **全変更を Issue + PR**（GitHub Flow / **squash merge のみ** / main 直 push 禁止 = ruleset で強制）
- ブランチ命名 `<type>/<short-description>`、Conventional Commits、PR タイトルもコミット規約に合わせる
- 実装は `docs/design/` の仕様に従う。仕様にない判断は ADR/Issue で先に決める

## Tech Stack

- Runtime: **Bun**（TypeScript をそのまま実行 / `bun build --compile` で単一バイナリ）
- Language: TypeScript (strict, ESM)
- DB: `bun:sqlite` + `sqlite-vec`（FTS5 + 任意 vec0）
- 読みモデル/migration: Drizzle ORM + drizzle-kit（event append は raw SQL）
- Validation/ドメイン: Zod（event 直和 / MCP tool schema / config）
- MCP: MCP TypeScript SDK
- CLI: clipanion（lazy import）
- Connectors: octokit / @slack/web-api / @microsoft/microsoft-graph-client + @azure/msal-node / googleapis / box / playwright
- Secrets: @napi-rs/keyring（env override 経路あり）
- Lint/Format: Biome ／ Version 管理: mise（`.mise.toml`）／ Hooks: lefthook

## 主要コマンド

```bash
bun install                # 依存インストール
bun run dev                # 開発実行
bun run build              # ビルド（bun build / --compile）
bun run typecheck          # tsc --noEmit
bun test                   # テスト
```

## 検証（必須）

コード変更後、報告前に以下を通すこと:

1. `bun run typecheck` — 型チェック通過
2. `bun test` — テスト通過
3. `mise exec -- lefthook run pre-commit --all-files` — lint/format/secret scan 通過

### CI 品質ゲート

`.github/workflows/ci.yaml` が PR / `main` push で以下を実行する。ローカル lefthook をバイパスした PR（`--no-verify` / Web 編集等）でも CI 側が正本としてガードする:

- `check`: typecheck + test + build。テストは `bun run test:coverage`（`scripts/coverage-gate.mjs`）で **overall の line/function カバレッジ閾値ゲート**を適用する（floor 未達は CI fail）。ローカルでも `bun run test:coverage` で同じゲートを再現できる（閾値は `COVERAGE_MIN_LINE` / `COVERAGE_MIN_FUNCTION` で上書き可）
- `lint`: Biome + markdownlint
- `security`: gitleaks（秘密情報、履歴全走査）/ Trivy（`fs` 脆弱性 + 秘密情報）/ actionlint（workflow lint）。ツールは `.mise.toml` のピン版を `jdx/mise-action` で導入する

## コーディング規約

- インデント: 2 スペース / 改行コード: LF / ファイル末尾: 改行あり
- Biome の設定（`biome.json`）に従う

## 規約

言語・コミット・ブランチ・PR のルールは README / CONTRIBUTING を参照。

## Available Skills

<!-- begin: @ozzylabs/skills -->
<!-- このブロックは sync-skills.sh が opt-in 後に自動管理する。opt-in していない場合は空のままで問題ない。 -->
<!-- end: @ozzylabs/skills -->

アシスタント 32 skill（Suasor 同梱・`suasor skills install`）の SSOT は `docs/skills/<name>/SKILL.md`（[ADR-0008]）。展開先の mirror（`.claude/skills/` / `.agents/skills/`）は **commit しない**（`.gitignore` 済みのローカル install 物・[ADR-0035]）。エコシステム共通 dev skill（drive / lint / commit 等）は `@ozzylabs/skills` 由来で、suasor 開発に使う **project skill として host dir に commit 済み**（更新手順: [docs/skills/dev-skills-refresh.md](docs/skills/dev-skills-refresh.md)）。

## Adapter Files

| Agent          | Configuration                         |
| -------------- | ------------------------------------- |
| Claude Code    | `CLAUDE.md`, `.claude/`               |
| Gemini CLI     | `.gemini/settings.json` → `AGENTS.md` |
| Codex CLI      | `AGENTS.md` + `.agents/skills/`       |
| GitHub Copilot | `AGENTS.md` + `.agents/skills/`       |
