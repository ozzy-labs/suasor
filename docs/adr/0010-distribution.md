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
