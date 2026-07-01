# 0037. Slack name enrichment（sync 時解決 + channel 名 projection）

- Status: Accepted
- Date: 2026-07-01
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event-sourced / replay-stable）, [ADR-0003](0003-local-first-and-content-minimization.md)（local-first / read 専用）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP read 境界）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（FTS-first）, [ADR-0007](0007-connector-contract.md)（connector 契約＝read 専用・sync 一本）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（scope readiness / `users.info`・`conversations.info` の位置づけ）, [ADR-0012](0012-slack-demand-digest.md)（`slack.demand.list`・no-fetch-at-query）, [ADR-0022](0022-person-identity-resolution.md)（person projection / `PersonIdentityObserved.displayName`）, [ADR-0026](0026-source-forgetting.md)（source forgetting / dangling 許容）
- Tracks: epic #354（PR0＝本 ADR。projection・event・reducer・migration＝PR1、user 名解決＝PR2、channel 名解決＝PR3、MCP join＝PR4、backfill verb＝PR5）

## Context

Slack の識別子は CLI / MCP / skill の出力で**生 ID のまま**提示される: channel ID（`C…` public / `G…` group DM / `D…` single DM）、user ID（`U…`）、team ID（`T…`）。人間はこれを見ても誰の・どのチャンネルの話か判別できない。

特に痛いのは 2 箇所:

1. **`slack.demand.list`（[ADR-0012](0012-slack-demand-digest.md)）** — @mention / DM の未処理 signal を返すが、どの channel の誰からの demand かが `C…` / `U…` のまま。`next-actions` / `personal-brief` skill がこれを priority 上位に組み込む際、ユーザーに「`C0123ABC` で `U0456DEF` にメンションされています」としか出せない。
2. **`slack status` / `cursor` 等の運用出力** — per-channel cursor（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) 決定 3）の channel が ID のみで、どの channel の同期状態かが読めない。

既存実装には名前解決の断片がすでにある: `src/connectors/slack/conversations.ts` の `resolveUserName` が `users.info` で `display_name → profile.real_name → real_name → name` の順にフォールバックし、DM の相手名を解決している。しかしこれは **ingest 時の source 表示名に閉じ**、projection として横断的に再利用できる形になっていない。channel 名に至っては解決経路そのものが無い。

核心の緊張は **[ADR-0012](0012-slack-demand-digest.md) の no-fetch-at-query 不変条件**にある。表示のたびに `users.info` / `conversations.info` を叩けば名前は出せるが、それは「query 時に Slack を追加で叩かない（local-first / read-only を維持）」という [ADR-0012](0012-slack-demand-digest.md) 決定 1 / [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md) の FTS-first 原則を破る。名前を出す価値と、query を純ローカルに保つ不変条件を両立させる設計を決める必要がある。

## Decision

**「sync 時に名前を解決してローカル projection へ保持 → 表示時（MCP / CLI）はローカル join のみで live fetch しない」** を基本方針とする。これにより local-first / FTS-first / [ADR-0012](0012-slack-demand-digest.md) の no-fetch-at-query 不変条件を維持したまま、生 ID を人間可読名へ enrich する。

### 1. 基本方針: 解決は sync 時、表示は join のみ

名前解決は connector の sync pass（read-only ingest）の中で行い、結果を projection（event 由来）へ焼く。MCP / CLI の表示層は projection を **join するだけ**で、Slack API を一切叩かない。多少の陳腐化（改名直後など）は許容し、鮮度は次回 sync の last-write-wins 更新で追従する（決定 8）。

### 2. user 名 — 既存 person projection に載せる（新テーブル不要）

user 名は [ADR-0022](0022-person-identity-resolution.md) の既存 person projection に載せる。`PersonIdentityObserved.displayName`（`src/events/types.ts` に optional で既存・reducer は last-write-wins 更新を実装済み。`src/projections/reducer.ts` の `case "PersonIdentityObserved"`）を sync 時に埋める。**新テーブルは作らない。**

- 解決器は `users.info`（**per-run キャッシュ**）で `display_name → profile.real_name → real_name → name` の順にフォールバックする。これは既存 `resolveUserName`（`src/connectors/slack/conversations.ts`）の順序を踏襲する（SSOT を分裂させない）。
- reducer の既存挙動として `displayName` は last-write-wins。空文字（`""`）での再 observe は既存 person 名を上書きしない no-op update であり（reducer は `name !== ""` の時のみ更新）、degrade（決定 7）と後続 enrich（決定 8）を両立する。

### 3. channel 名 — 新規 `slack_channels` projection

channel 名の受け皿となる新規 projection `slack_channels` を追加する。

- **カラム**: `channel_id`（PK）, `team_id`, `name`, `kind`（`public` | `private` | `group` | `dm`）, `observed_at`。
- **新 event `SlackChannelObserved`** — payload: `channelId`, `teamId`, `displayName?`, `kind`。`DomainEvent` discriminated union への additive な新 type 追加であり `schemaVersion` は据え置き（既存 payload 不変・[ADR-0002](0002-event-sourced-architecture.md) upcast 不要）。
- **reducer は last-write-wins**（改名追従）。同一 `channel_id` の再 observe で `name` / `kind` / `observed_at` を上書きする（`SlackChannelObserved` の reducer case が upsert）。

### 4. DM の名前解決

- **single DM（`D…`）** = 相手 participant（`self_user_id` 以外・[ADR-0012](0012-slack-demand-digest.md) / [ADR-0022](0022-person-identity-resolution.md)）の `display_name`。決定 2 の user 解決器を再利用する。
- **group DM（`G…`）** = participant 名の join。取得不可の participant は ID フォールバックで併記する。

### 5. 解決方式 — on-demand + per-run キャッシュ

実際に出現した id のみを解決する（sync で観測した channel / user だけ）。`users.info` / `conversations.info` を per-run キャッシュ付きで叩き、同一 run 内の重複解決を避ける。bulk 列挙（`users.list` / `conversations.list`）は代替案として却下する（大規模 workspace で重く、出現しない id まで取得する。Alternatives 参照）。

### 6. scope 不足 / API エラー時の degrade

解決に失敗しても ingest はエラーにしない（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) の「silent wrong answer は出さないが、scope 不足は degrade」姿勢と同型）。

- 解決失敗時は `displayName: ""`（**空文字。null ではない**）で event を emit する。
- 表示層は名前が空なら **ID-only にフォールバック**する。
- 後続 sync で scope が揃えば last-write-wins で enrich される（決定 8）。
- `""` を採ることで、person 側 reducer の「空文字は既存名を上書きしない」挙動（決定 2）と、channel 側の「名前欄が空 = ID フォールバック」表示が一貫する。

### 7. 鮮度 — last-write-wins、追加 fetch なし

該当 channel / user を sync するたびに last-write-wins で更新する。鮮度のためだけの追加 fetch はしない。改名の追従は「次にその channel / user を含む sync が走ったとき」に起こり、それまでの多少の陳腐化は許容する。

### 8. source-forgetting（[ADR-0026](0026-source-forgetting.md)）との関係

source を forget しても **`slack_channels` 行・person `display_name` は削除しない**。理由は複数 source が同一 channel / person を参照しうるため（1 つの機密メッセージを forget しても、その channel 名や発言者名は他の source からも参照される共有された参照データであり、特定 source の本文とは粒度が違う）。これは [ADR-0026](0026-source-forgetting.md) 決定 5 の「links は残す（dangling 許容）」・person / person_identities が forget で消えない dangling 許容と同型である。名前 enrichment は本文（body）ではなく参照メタデータなので、`source.forget` の redaction 対象（body 空白化）にも含めない。

### 9. projection 追加時の配線

`slack_channels` projection の追加に伴い、以下をすべて同期する（[ADR-0002](0002-event-sourced-architecture.md) の projection 追加規約）:

- `src/db/schema.ts` — `slack_channels` テーブル定義（drizzle）。
- `src/db/connection.ts` の `initSchema()` — `CREATE TABLE IF NOT EXISTS slack_channels (...)`。
- 新 drizzle migration — `slack_channels` の DDL。
- `src/projections/rebuild.ts` の `PROJECTION_TABLES` — truncate 対象に `slack_channels` を追加（rebuild = truncate → 全 event replay の整合。[ADR-0026](0026-source-forgetting.md) 決定 3 と同型）。
- `src/db/store-info.ts` の `PROJECTION_TABLES` — 行数カウント対象に追加。
- `src/events/types.ts` — `SlackChannelObserved` の event 定義 + discriminated union + 名前リスト（`EVENT_TYPES` 等）への追加。
- `src/projections/reducer.ts` — `case "SlackChannelObserved"`（upsert / last-write-wins）。

user 名側（決定 2）は `PersonIdentityObserved.displayName` の再利用のため、event / projection / reducer の新規追加は不要（sync 経路で displayName を埋めるだけ）。

### 10. MCP — `slack.demand.list` の応答に名前を追加

`slack.demand.list`（[ADR-0012](0012-slack-demand-digest.md)）の応答に `channelName` / `userName` / `teamName` を追加する。値は **person_identities + slack_channels からのローカル join** で得る（live fetch なし。決定 1 の no-fetch-at-query 不変条件を維持）。名前が空なら ID をそのまま返す（決定 6 のフォールバック）。read-only tool のまま（`readOnlyHint: true`）で、write は導入しない。

### 11. backfill

既存の同期済み source に対して名前を遡及解決する verb を用意する（前方 sync だけでなく backfill）。既に取り込み済みで displayName / channel 名が空のままの demand / channel を、`users.info` / `conversations.info` の per-run キャッシュ解決で埋め、`PersonIdentityObserved` / `SlackChannelObserved` を append して projection を last-write-wins で enrich する。

## Consequences

### Positive

- 生 ID（`C…` / `U…` / `T…`）が人間可読名になり、`slack.demand.list` / `slack status` / `cursor` の可読性が上がる。`next-actions` / `personal-brief` が「誰から・どの channel で」を提示できる。
- 解決を sync 時に閉じ、表示を join のみにすることで [ADR-0012](0012-slack-demand-digest.md) の no-fetch-at-query / [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md) FTS-first / [ADR-0003](0003-local-first-and-content-minimization.md) local-first を不変に保つ。
- user 名は既存 person projection（[ADR-0022](0022-person-identity-resolution.md)）に載せるため新テーブル不要。connector 横断の「人」軸とも自然に統合される。
- 名前解決を event（`PersonIdentityObserved` / `SlackChannelObserved`）に焼くため replay-stable（[ADR-0002](0002-event-sourced-architecture.md)）。rebuild 後も再現される。
- degrade（決定 6）と後続 enrich（決定 8）を空文字セマンティクスで一貫させ、scope 不足でも ingest を止めない（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) 整合）。

### Negative / Trade-offs

- 新 projection `slack_channels` の追加で、schema / initSchema / migration / rebuild / store-info / events / reducer の 7 箇所配線が要る（決定 9）。配線漏れは replay 不整合や行数カウント欠落を生むため、PR1 で機械的に揃える。
- sync 時に `users.info` / `conversations.info` の round-trip が増える（per-run キャッシュで同一 run 内は 1 回に抑えるが、初回 / 新規 id では追加 API コール）。rate limit は既存の retry（[ADR-0019](0019-slack-fetch-path-rate-limit-retry.md)）に従う。
- 改名の追従が next-sync 依存（決定 7）で、sync 間は陳腐化しうる（許容する割り切り）。
- backfill verb（決定 11）のぶん CLI / 運用表面が増える。

## Alternatives Considered

- **(a) 表示時 live fetch（query のたびに `users.info` / `conversations.info`）** — 却下。[ADR-0012](0012-slack-demand-digest.md) の no-fetch-at-query 不変条件・[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md) FTS-first・[ADR-0003](0003-local-first-and-content-minimization.md) local-first を破る。read tool が外部 I/O に依存し、offline / rate-limit 時に degrade する。
- **(b) channel 名を `sources.meta` に非正規化（source ごとに channel 名を焼く）** — 却下。改名追従が難しく（過去 source の meta は古い名前のまま）、同一 channel が N source ぶん重複保持され、backfill も source 単位で重くなる。1 行 / channel の projection（決定 3）の方が改名追従・重複排除・backfill いずれの観点でも優る。
- **(c) bulk 解決（`users.list` / `conversations.list` で全件先読み）** — 却下。大規模 workspace で重く、実際には出現しない id まで取得する。on-demand + per-run キャッシュ（決定 5）で必要な id のみ解決する方が軽量で、[ADR-0011](0011-slack-operational-verbs-and-readiness.md) の membership 前提（未参加 channel は解決対象外）とも整合する。
