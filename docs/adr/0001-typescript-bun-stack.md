# 0001. TypeScript / Bun stack

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor は (1) **MCP server として AI エージェントに消費される**こと、(2) ローカルファーストの単一ユーザー向けツールであること、(3) 多数の SaaS connector（GitHub / Slack / Microsoft Graph / Google / Box / Web）から取り込むこと、(4) solo + AI エージェントで開発されること、が前提。言語選定はこの「system レベルのフィット」で決める。

## Decision

**TypeScript（strict / ESM）を Bun ランタイム**で実装する。中心スタック:

| 用途 | 採用 |
|---|---|
| Runtime | Bun（TS を直接実行 / `bun build --compile` で単一バイナリ） |
| DB | `bun:sqlite` + `sqlite-vec` |
| 読みモデル / migration | Drizzle ORM + drizzle-kit（event append は raw SQL） |
| Validation / ドメイン | Zod（event 直和 / MCP tool schema / config） |
| MCP | MCP TypeScript SDK |
| CLI | clipanion |
| Lint / Format | Biome |
| Secrets | @napi-rs/keyring |

成立条件: [ADR-0006](0006-ml-delegation.md)（ML 委譲）を守る限り、言語は ML に縛られず中立。

## Consequences

### Positive
- **MCP 生態系と同言語**（リファレンス SDK が TS） — 消費面と実装が一致
- `@ozzylabs` npm scope に合流、配布が容易（npm + 単一バイナリ）
- connector SDK が充実（octokit / Playwright が TS ネイティブ 等）
- 構造的型 + Zod で runtime validation も担保

### Negative / Trade-offs
- migration の auto-generate は弱め（Drizzle）。event-sourced で projection が replay 再構築可能なため影響は限定的（[ADR-0002](0002-event-sourced-architecture.md)）
- in-process の重い ML（モデル実行）には不向き → [ADR-0006](0006-ml-delegation.md) で委譲を不変条件化

## Alternatives Considered
- **Python** — ML/データは強いが、Suasor は ML を委譲するため優位が中立化。MCP 生態系・配布・npm 整合で TS に劣る
- **Go** — 単一バイナリは最良だが sum 型がなく event 直和の表現が弱い。connector SDK も一段薄い
- **Rust** — correctness は最良だが開発速度が最も遅く、主要 SaaS の公式 SDK が乏しい
