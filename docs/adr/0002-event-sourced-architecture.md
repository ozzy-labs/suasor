# 0002. Event-sourced architecture

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor は connector からの取り込み・ユーザー/エージェントの操作・提案の承認などを継続的に記録し、検索・要約・提案の土台にする。データモデルが時間とともに進化する（新 connector・新 projection）ため、スキーマ変更に強く、来歴（provenance）を辿れる基盤が要る。

## Decision

**event-sourced** を採る。**追記専用の event store が唯一の真実**で、`tasks` / `decisions` / `inbox` / `sources` 等の読みモデル（projection）は event の **replay で再構築可能**にする。

- event は Zod の discriminated union（immutable / versioned）
- append 経路は raw SQL（高速・単純）、projection は Drizzle 管理
- `suasor projections rebuild` で event を流し直して projection を同値復元できる

## Consequences

### Positive

- 来歴を辿れる（提案 → 承認 → task 化 などの連鎖）
- projection が使い捨て可能 → スキーマ変更は「drop して rebuild」で済み、in-place migration の比重が下がる（[ADR-0001](0001-typescript-bun-stack.md) の Drizzle migration 弱点を緩和）

### Negative / Trade-offs

- event schema の versioning / upcasting はドメインコードで丁寧に扱う必要がある
- 読み取りは projection 前提（生 event を直接引かない）

## Alternatives Considered

- CRUD + 単純テーブル → 却下。来歴が残らず、projection 再構築の柔軟性も失う
