# 0010. Distribution

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor は (1) AI エージェント利用者（既に Node/Bun を持つ層）、(2) 手元で動かす単一ユーザー、(3) air-gap/再現性を求める層、に届けたい。[ADR-0006](0006-ml-delegation.md) により core は重い ML を持たないので軽量配布が可能。

## Decision

複数チャネルで配布する:

1. **npm `@ozzylabs/suasor`**（canonical） — `bunx`/`npx` で MCP 起動も可。`@ozzylabs` scope に合流
2. **Bun 単一バイナリ**（`bun build --compile`） — OS/arch 別に GitHub Releases へ。**ランタイム前提ゼロ**（重い ML を持たないので軽量）
3. **Docker（batteries-included）** — Suasor + Ollama 同梱。local embedding を使う層向け
4. **MCP registry 掲載** — エージェントホストからの発見性

依存更新は Renovate（`renovate.json` extends `github>ozzy-labs/.github`）。

### リリースプロセス（release-please 駆動）

リリースは **release-please**（Conventional Commits 駆動）で自動化する（org の npm パッケージ群と統一）。当初の「手動 GitHub Release」モデルを置き換える。

- `main` への push ごとに release-please が **release PR**（`chore(main): release vX.Y.Z`）を開く/更新し、commit を version bump（`package.json`）+ `CHANGELOG.md` に束ねる。SemVer 0.x の間は `feat` → minor / `fix` → patch（`bump-minor-pre-major` + `bump-patch-for-minor-pre-major`）
- release PR をマージすると release-please が git tag + GitHub Release を作成（`release_created`）し、**同一ワークフロー**（`.github/workflows/release.yaml`）内で npm（OIDC Trusted Publisher）/ 単一バイナリ / Docker を publish する
- publish を同一ワークフローに置くのは load-bearing：release-please が `GITHUB_TOKEN` で作る tag/Release は `on: release` / `on: push: tags` を**カスケード起動しない**（GitHub の anti-recursion）ため、publish を別ワークフローに分離すると発火しない
- npm Trusted Publisher は workflow ファイル名 `release.yaml` に紐づくため、ファイル名は固定する
- 設定: `release-please-config.json`（`release-type: node`）/ `.release-please-manifest.json`（現行リリース版を記録）

## Consequences

### Positive

- ランタイム持ちには npm、手ぶらには単一バイナリ、local embedding 込みには Docker、と層ごとに最適
- core が軽いので単一バイナリ・配布が現実的（[ADR-0006](0006-ml-delegation.md) の果実）

### Negative / Trade-offs

- 厳密には「単一バイナリ + ごく少数の native 同梱」（sqlite-vec 拡張 / keychain）になる
- npm 版が動く先（Node/Bun）はドライバ選択に依存（Bun 専用 API を使う場合は Bun 前提）

## Alternatives Considered

- 単一チャネルのみ → 却下。利用者層が異なる（エージェント / 手元 / air-gap）
- Homebrew / 言語パッケージ単独 → 補助として可だが、npm + 単一バイナリ + Docker でカバー
