# 0042. Slack workspace-less connector（canonical channel identity + unnamed token pool）

- Status: Accepted
- Date: 2026-07-21
- Deciders: Suasor maintainers
- Tracking: [#464](https://github.com/ozzy-labs/suasor/issues/464)
- Supersedes: [ADR-0014](0014-slack-multi-workspace.md)（multi-workspace config 形状）, [ADR-0038](0038-multi-workspace-shared-channel-dedup.md)（owner-wins dedup 3 層）
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event-sourced / externalId 冪等性）, [ADR-0007](0007-connector-contract.md)（connector 契約）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（運用 verb / readiness）, [ADR-0012](0012-slack-demand-digest.md)（demand digest / self_user_id）, [ADR-0016](0016-slack-sync-date-floor.md)（date floor）, [ADR-0036](0036-task-external-home.md)（task read-back の externalId join）, [ADR-0037](0037-slack-name-enrichment.md)（name enrichment / team 表示）, [ADR-0039](0039-conversation-discovery-drift.md)（discovery drift）

## Context

[ADR-0014](0014-slack-multi-workspace.md) の multi-workspace 構成は、workspace alias が **3 つの別々の関心事を 1 つに束ねる**設計だった:

1. **credential**（per-alias token `connector:slack:<alias>:token`）
2. **ingestion namespace**（externalId の team prefix `slack:<team>:<channel>:<ts>`）
3. **owner-election key**（[ADR-0038](0038-multi-workspace-shared-channel-dedup.md) の辞書順最小 alias）

この束ねが 3 つの構造問題を生んだ:

- **到達性トラップ（silent drop）** — 共有チャンネルの owner は config 上の alias 辞書順で固定され（`src/connectors/slack/dedup.ts` `channelOwnership`）、**token の到達性を見ない**。非 owner は sync 時に skip され（`src/connectors/slack.ts` の owner-skip）、owner の fetch 失敗に他 alias へのフォールバックが無い。owner 側 workspace の退出・共有解除が起きると、**他 workspace から読めるにもかかわらず誰も取り込まない**状態が warn のみで発生する（ADR-0038 Consequences の既知 Negative）。
- **discovery の UX 摩擦** — per-workspace token では `slack conversations` が横断を見られず（Grid auto-enumeration は org-level token 限定）、共有チャンネルが各 workspace の出力に無印で重複する。ユーザーは「どの alias にどのチャンネルを書くか」を判断材料なしに毎回決めさせられる。
- **管理概念の過剰** — alias 命名・per-alias env var（`SUASOR_CONNECTOR_SLACK_<ALIAS>_TOKEN`）・alias ネスト cursor・per-alias `since`/`self_user_id` は、いずれもユーザーのメンタルモデル（「自分の Slack のチャンネルを追う」）に存在しない概念の管理を強いる。

根本原因は **message externalId の team prefix** にある。Slack Lists の externalId（`slack:list:<listId>:item:<id>`）は team 非依存で「同一 list を複数 alias に設定しても自然に collapse し dedup 不要」（ADR-0038 §5）なのに対し、message だけが team で名前空間化されているため owner election が必要になる、という非対称である。ADR-0038 §7 自身が恒久解を「externalId の team 非依存化（`slack:<channel>:<ts>` へ canonical 化）。これにより owner 概念そのものが不要になる」と明記した上で、当時は [ADR-0036](0036-task-external-home.md) の task read-back join を理由に見送っていた。

本 ADR は [#464](https://github.com/ozzy-labs/suasor/issues/464) の設計検討（到達性トラップの分析・UX レビュー）を受け、恒久解を採用して workspace という管理単位を廃止する。

## Decision

### 1. identity — `slack:<channel>:<ts>` へ canonical 化（team prefix 除去）

message の externalId を `slack:<team>:<channel>:<ts>` から **`slack:<channel>:<ts>`** に変更する。

- **channel id は Slack 全体でグローバル一意**（ADR-0038 §1 の分析: 「たまたま別 org が同一 ID を持つことはなく、誤 dedup は起きない（安全なキー）」）。namespace prefix は dedup に寄与しない。
- 共有チャンネルはどの workspace・どの token で取り込んでも**同一 externalId に collapse** し、fingerprint の externalId 冪等性（[ADR-0002](0002-event-sourced-architecture.md)）だけで重複が消える。**owner election（ADR-0038 の 3 層）は概念ごと不要になる。**
- Lists の externalId（`slack:list:…`）と同じ「identity は Slack のグローバル一意 id、org/team は表示 facet」という原則に message も揃い、非対称が解消する。
- [#464](https://github.com/ozzy-labs/suasor/issues/464) 起票時の `slack:<enterprise_id ?? team_id>:<channel>:<ts>` 案は本 ADR で**さらに簡約**した。org prefix は (a) dedup 上の価値がゼロ（channel id が既に一意）、(b) standalone workspace の Grid 編入で namespace が変わり identity break する edge を持ち込む、(c) Slack Connect（cross-org 共有・同一 channel id）を二重化させる — の 3 点で劣後する。channel-only なら (b)(c) も構造的に消える。
- **ADR-0036 の task read-back join は影響を受けない（確認済み）**: `published_external_id` を構成するのは task home の externalId（`slack:list:<id>:item:<id>` — `src/connectors/slack-lists-actuator.ts`、`jira:…` — `src/connectors/jira-actuator.ts`、GitHub 形式）のみで、message の externalId は join 対象でない。ADR-0038 §7 が canonical 化を見送った理由は message id には当たらない。
- org / team は **表示 facet として `meta`（`teamId` / team 名、[ADR-0037](0037-slack-name-enrichment.md)）に保持**する。検索・brief で「どの workspace の話か」を出す用途は identity ではなく metadata が担う。

### 2. token — 無名 credential プール（alias 命名の廃止）

per-alias token を廃止し、**命名しない token プール**に置き換える。

- **secret 名は `tokens` の 1 つ**: keychain account `connector:slack:tokens`、env override `SUASOR_CONNECTOR_SLACK_TOKENS`（既存の `secretEnvName` 規約から自然導出。専用機構は増やさない）。値は**改行またはカンマ区切りの token リスト**。
- **env / `auth set` は全置換 semantics**（追記型にしない。死 token の残留を防ぐ）。`slack auth set` は stdin から N 行を受けてプール全体を置き換える。
- **各 token はツールが `auth.test` で自己記述**する（org/team 名・self user id・granted scopes・到達 channel 数）。ユーザーは alias を発明せず、表示ラベルは org/team 名から自動で振る。
- **同一 team への重複 token は無害**（どちらか 1 枚を使う。仕様として明記）。
- **導線は「可能なら org-level（org-wide app）token 1 枚」を最短として案内**し、無理なら workspace token を必要数、とする（貼る枚数の最小化）。
- `self_user_id` config は **`self_user_ids = ["U…"]`（任意・複数）に置き換え、user token からの自動導出で補完**する。`auth.test` の user id 自動採用は **user token（`xoxp-`）に限る** — bot token（`xoxb-`）の `auth.test` は bot 自身の user id を返すため、これを self に採ると [ADR-0012](0012-slack-demand-digest.md) の @mention 検出が「bot 宛て mention」を拾う silent wrong answer になる（[ADR-0007](0007-connector-contract.md) 違反）。判定は「config の `self_user_ids` ∪ pool 内 user token の auth.test user id」の集合で行い、**どちらも無い場合は既存挙動どおり DM-only へ degrade し明示 warn** する。
- **user-token 限定機能の token 選択は scope ベース**: engagement axis（`slack conversations --sort=last_self_post`、`search:read`＝User Token 限定、[ADR-0013](0013-slack-engagement-axis.md)）などは、pool から必要 scope を満たす token を選んで実行し、該当 token が無ければ従来どおり `N/A` degrade する。

### 3. 取得 — 到達性ベースの token 選択 + bounded failover

- sync は**プール内の各 token で `users.conversations` を引き（per-run キャッシュ）、channel → 読める token 集合の map** を作る。
- 各 configured channel は**読める token のうち 1 つ**で取得する。選択 token が channel-scoped エラーで失敗したら**次に読める token を 1 枚だけ試す**（bounded failover。無限リトライにしない）。
- **cursor は channel 単位の flat map**（`{ "<channel>": ts, "<channel>#<thread_ts>": ts }`）。どの token が取ったかに依存しない（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) の per-channel cursor / [ADR-0015](0015-slack-thread-replies.md) の thread key はそのまま、alias ネストだけを外す）。
- これにより **token 失効・workspace 退出・共有解除で読める経路が残る限り取り込みは自己回復**する。全 token で読めない channel だけが unreachable warn（ADR-0011 の集約 warn を流用）に落ちる。
- エラー隔離は **per-token × per-channel**: 1 token の失敗（auth 死・ratelimited）は他 token を止めず、channel-scoped エラーは他 channel を止めない（ADR-0014 の per-workspace 隔離と同じ不変条件を token 軸に写像）。

### 4. config — flat 化（workspaces テーブルの廃止）

```toml
[connectors.slack]
channels = ["C0123ABCD", "G0456…"]   # 対象 channel id の flat リスト（Grid 内一意なので workspace 分類不要）
since = "30d"                        # cold-start floor（ADR-0016。per-alias 概念は廃止）
discover_new = true                  # ADR-0039（per-alias override は廃止、connector 単位のみ）
lists = ["L0123"]                    # Slack Lists（従来どおり）
# self_user_ids = ["U0SELF"]         # 任意。@mention 検出の self 集合（決定 2。user token からの自動導出を補完）
[connectors.slack.channel_since]
C0123ABCD = "90d"                    # per-channel override（従来どおり）
```

- `[connectors.slack.workspaces.<alias>]` テーブル・`team` フィールド・`self_user_id` フィールドは**廃止**（team は auth.test 由来の表示 facet、self は決定 2）。
- **id が truth**: `channels` は従来どおり id のみ。人間名は discovery / picker（決定 6）の入出力と config コメントに限る（rename は drift 追随、ADR-0039）。

### 5. status / エラー通知 — 「token 死」と「channel 不達」の区別

`slack status` / sync warn は復旧アクションが異なる 2 つを別の言葉で出す:

- **token 死**（auth.test 失敗 / revoked）: 「`<org 名>` の token が失効 → 差し替え」
- **channel 不達**（全 token で読めない）: 「`#x` はどの token でも読めない → `<欠落 org 名>` の token を追加」

ユーザーは token→channel の対応付けを管理せず、**欠けている org を名指しされて token を足すだけ**にする（カバレッジ通知ループ）。

### 6. discovery / 選択 UX — suggest-and-confirm picker（実装は後続 PR）

- 初回導線は **suggest-and-confirm**: アクティブな channel（直近の自分の読み書き）を**チェック済み**で提示し、**DM / group-DM は未チェック（opt-in）**、確認 1 回で `channels` に反映する。自動取り込み（確認なし）は採らない（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md) の HITL 哲学と整合。DM を無確認で index する surprise を避ける）。
- 以後の増減は `follow` / `unfollow "#name"`（名前→id 解決。同名衝突は org 名で曖昧性回避）。
- `slack conversations` は**プール内全 token を sweep して横断表示**する（org-level token 限定だった横断が、per-workspace token 構成でも成立する）。同一 channel id は 1 行に集約し `(shared)` を付す。owner 概念が無いので「どちらに書くか」の判断は発生しない。

### 7. actuator / notify の token 選択

`workspace = "<alias>"` を参照していた設定（`[notify]` の slack-dm チャネル、`[tasks.homes.slack]` の multi-workspace lists 注記）は alias 廃止に伴い、**到達性ベースの自動選択**（対象 list / DM に届く token を選ぶ）+ 曖昧時の任意 `team = "T…"` disambiguator に置き換える。

### 8. 前提制約（明文化）

- **「ユーザー自身の custom app + user/bot token」が前提**である。Slack は非 Marketplace の商用配布 app に対し `conversations.history` / `replies` を 1 req/min + 15 件へ制限した（新規 app は 2025-05-29 から、既存インストールも 2026-03-03 から）。**internal custom app は対象外（50+ req/min）であり、この前提が本設計の生存経路**（参照: <https://api.slack.com/changelog/2025-05-terms-rate-limit-update-and-faq>）。suasor が「配布された共有 app」へ移行する場合は本 ADR の取り込み戦略ごと再検討が必要。
- **cold-start floor（`since`、ADR-0016）は維持**する。custom app の rate limit 内でも初回取り込み量の bound は必要。
- **Slack Connect**: channel id のグローバル一意性の下では cross-org 共有チャンネルも同一 externalId に collapse する（旧 ADR-0038 §6 の二重化 caveat は identity canonical 化で構造的に解消）。ただし実機検証は未実施のため best-effort とし、実装 PR のテストは同一 Grid 前提を主系とする。

### 9. 移行（既存環境）

後方互換 config 解釈は**持たない**（[#464](https://github.com/ozzy-labs/suasor/issues/464) の決定。旧 `workspaces` テーブル / per-alias token を検出したら**明確な移行エラー**で新形式を案内する）。データ移行は:

- **event log は書き換えない**（[ADR-0002](0002-event-sourced-architecture.md)）。既存 message source は旧 externalId（`slack:<team>:<channel>:<ts>`）のまま残る。
- **cursor は flatten して引き継ぐ**: 旧 nested cursor（`{ "<alias>": { "<channel>": ts } }`）は channel ごとに全 alias の **max ts へ潰して**新 flat map に変換する（再 cold-start の回避。決定的・一回限り）。
- 新規 sync は canonical id で取り込む。cursor を引き継ぐため、**通常は旧新の重複 window は生じない**（旧 id 群は過去分、新 id 群は cursor 以降）。検索等で旧 source と新 source が別系統に見える点は許容し、旧系統の cleanup は既存ガイド（`source list` → `source forget`、ADR-0038 導入時の cleanup 手順と同型）を guide に記載する。

## Consequences

### Positive

- **到達性トラップの構造的消滅**: owner 概念が無いので「owner が読めず誰も取り込まない」状態が定義上存在しない。読める token がある限り自己回復し、残る失敗モードは「全 token 不達」の 1 つだけ — それは人間語（欠落 org の名指し）で通知できる。
- **管理概念の削減**: alias 命名・per-alias env var・alias ネスト cursor・owner election 3 層（sync skip / discovery マーキング / doctor warn）・共有チャンネル cleanup ガイドの大半が**コードごと消える**。config は flat リスト 1 本になる。
- **discovery の横断が per-workspace token でも成立**: `slack conversations` がプール全体を 1 回で見せ、重複判断・重複記載の UX 摩擦が消える。
- **Slack Connect の二重化も解消**（best-effort）: identity が channel-only なので cross-org 共有も collapse する。
- **Lists と message の identity 原則が統一**され、ADR-0038 §5 の非対称が消える。

### Negative / Trade-offs

- **識別子移行が破壊的**: 既存 Slack message source は旧 externalId のまま残り、新規取り込みと系統が分かれる。旧系統の整理は手動 cleanup（guide 記載）。graph links / provenance の旧 source 参照はそのまま生きる（dangling 許容、[ADR-0026](0026-source-forgetting.md) と同型）。
- **sync 前の到達性 map 構築に per-token の `users.conversations` round-trip が増える**（per-run キャッシュで 1 token 1 回に抑制。rate-limit は [ADR-0019](0019-slack-fetch-rate-limit-retry.md) の共有 retry に乗る）。
- **workspace 単位の運用概念（per-alias since / discover_new override / `--workspace` flag）が消える**: alias 単位で floor を変えていた環境は per-channel override（`channel_since`）で代替する。
- **旧 config の無変換エラー**: 既存 multi-workspace ユーザーは config 書き換えが必須（移行エラーが新形式を案内するが、自動変換はしない — 変換の曖昧さ（per-alias since の統合など）を silent に解決しないため）。
- meta の `teamId` は「取得に使った token の team」になり、共有チャンネルでは**どの token が取ったかで揺れ得る**（identity ではないので実害は表示のみ。last-write-wins で収束、ADR-0037 の位置づけを「表示 facet」に明確化）。

## Alternatives Considered

- **(a) org namespace 化 `slack:<enterprise_id ?? team_id>:<channel>:<ts>`（#464 起票時の形）** — 却下（決定 1）。channel id が既にグローバル一意なので prefix に dedup 価値が無く、Grid 編入 edge と Slack Connect 二重化を持ち込む。channel-only が厳密に優る。
- **(b) ADR-0038 の owner-wins を維持し、owner を reachability-aware に拡張** — 却下。到達性で owner を動かすと externalId の team prefix が揺れて旧 source が orphan 化する（0038 が辞書順固定を選んだ理由そのもの）。prefix を残す限り「決定性」と「到達性」は両立しない。根本原因（prefix）を除去する方が単純。
- **(c) 旧 config の後方互換解釈（workspaces テーブルを flat に自動変換）** — 却下（決定 9）。per-alias since / self_user_id / discover_new の統合規則が自明でなく、silent な解釈は誤設定を隠す。明確な移行エラー + 案内の方が誠実（[ADR-0007](0007-connector-contract.md) の「silent wrong answer を出さない」）。
- **(d) OAuth フローの導入（token 手動設定の廃止）** — 対象外。配布 app 化は決定 8 の rate limit 制約に抵触する。token 手動 + custom app 前提を維持する。
- **(e) 全チャンネル自動取り込み（picker なし・ゼロ確認）** — 却下（決定 6）。DM を無確認で検索可能 index に入れる surprise と cold-start コストが HITL 哲学（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md)）に反する。suggest-and-confirm の確認 1 回を残す。
