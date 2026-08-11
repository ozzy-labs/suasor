# MCP Surface

[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)。MCP TS SDK（`@modelcontextprotocol/sdk`、stdio transport）で公開。tool 入力は Zod schema。read / write を明確に分ける。`suasor mcp serve` で起動する。

read tool 群は `src/mcp/`（`server.ts` = factory のみ / `server-read.ts` = read tool 登録 / `server-write.ts` = write tool 登録 / `queries.ts` = projection SELECT / `serve.ts` = stdio 起動）で実装。read tool はすべて副作用なし（projection を SELECT するか FTS-first search service を呼ぶだけ）で、各 tool に `readOnlyHint: true` annotation を付け、host が auto-approve できるようにしている。

## Read tools（副作用なし・エージェント自律 OK）

| tool | 役割 | 状態 |
|---|---|---|
| `search` | FTS5 全文検索（`sourceType` / `observed*` フィルタ可、[retrieval](retrieval.md)） | #8 実装済（フィルタ #142） |
| `search（mode=semantic）` | 意味検索（embedding 有効時の vec0 KNN。`sourceType` / `observed*` フィルタ可。無効/未到達時は空 + シグナルで FTS フォールバック） | 実装済（[#11]、フィルタ #142） |
| `search（mode=hybrid）` | FTS × 意味検索の RRF 融合（`sourceType` / `observed*` フィルタ可。embedding 無効時は FTS のみに degrade、[retrieval](retrieval.md)） | 実装済み（#142。下記参照） |
| `source.list` / `source.get` | source 一覧 / 本文取得 | #8 実装済 |
| `source.get`（`include`） | source の metadata + body + outgoing provenance links + extraction_meta を 1 コールでバンドル（`source.get` + `graph.related(out)` + 抽出 sidecar の再利用、#279） | 実装済み（#279。下記参照） |
| `source.history` | source の本文版を event log から新しい順に取得（真の差分用、#121） | 実装済み（下記参照） |
| `task.list` / `decision.list` / `inbox.list` | projection 一覧（時間フィルタ可） | #8 実装済 |
| `propose.list` | 提案候補の lifecycle ledger 一覧（state: `pending` / `applied` / `rejected`、kind フィルタ可） | 実装済み（#89。下記参照） |
| `commitment.list` | commitment 台帳一覧（state: `open` / `resolved` / `dismissed`、direction: `owed_by_me` / `owed_to_me` フィルタ可、[ADR-0021](../adr/0021-commitment-ledger.md)） | 実装済み（#91。下記参照） |
| `demand.list` | connector 中立 demand（Slack @mention/DM + github notification + 未返信 email（[ADR-0043](../adr/0043-email-demand-signals.md)）+ 直近 meeting（[ADR-0044](../adr/0044-calendar-proximity-signals.md)））の未処理 signal。既定は un-acked のみ（`sources` からの query 導出・追加 fetch なし、[ADR-0041](../adr/0041-neutral-demand-priority-substrate.md)。旧 `slack.demand.list` を置換） | 実装済（#419） |
| `priority.list` | 決定論的 cross-entity scorer: tasks + open commitments + un-acked demand を固定 comparator で 1 本のランク付きリストに合成（overdue > demand 鮮度 > dueDate 近接 > priority > 更新順、[ADR-0041](../adr/0041-neutral-demand-priority-substrate.md)） | 実装済（#419） |
| `person.list` | 解決済み person 一覧 + 各 person の connector identity（`includeEmpty?`、[ADR-0022](../adr/0022-person-identity-resolution.md)） | 実装済み（#92。下記参照） |
| `brief` | 期間バンドル（tasks/decisions/inbox/sources/demand/commitments を期間で束ねる read tool。要約は host、[ADR-0017](../adr/0017-brief-period-bundle.md)） | 実装済み（#70） |
| `sync.status` | 取り込み鮮度（connector 別の最新 run + `ok`/`stale`/`never`/`failing` 判定・[#442](https://github.com/ozzy-labs/suasor/issues/442)） | 実装済み（#442。下記参照） |
| `activity.timeline` | entity 軸の時系列ビュー（person/project/source 等を起点に provenance 接続された source/task/decision をマージし新しい順に返す。`brief` の期間軸と対をなす entity 軸、#279） | 実装済み（#279。下記参照） |
| `graph.related` / `graph.expand` | 既存 `links` projection 上の provenance traversal（`derived_from` / `replies_to` / `references` / `manual_link`。手動 link は `linkId` 付き、[ADR-0018](../adr/0018-knowledge-graph-traversal.md)）。`graph.expand` の `direction` で後方トレース（[ADR-0020](../adr/0020-multi-actor-coordination-scope.md)、下記参照） | 実装済み（#71・#90 / #97） |

戻り値はすべて 1 個の `text` content（JSON 文字列）。時間フィルタは各 projection の自然な timestamp 列を対象にし、**下限 inclusive (`>=`) / 上限 exclusive (`<`)**（隣接レンジの二重計上を避ける）。`iso` は ISO 8601（offset 付き）datetime。`limit` は正整数で上限 500。

list 系 tool（`source.list` / `task.list` / `decision.list` / `inbox.list` / `propose.list` / `commitment.list` / `person.list` / `demand.list` / `priority.list`）は本体配列に加えて `truncated`（boolean）を返す。ちょうど `limit` 件取得したとき「全件か打切りか」を agent が判別できるようにするためで（[ADR-0007](../adr/0007-connector-contract.md) の "no silent wrong answer"、`search` の `totalHits`/`truncated` と一貫）、実装は `limit + 1` 件取得して超過していれば切り詰める。`truncated: true` のときは時間フィルタを狭めて再取得する（full page = 完全と決めつけない）。後方互換の additive field。

### `search`（確定・FTS-first）

FTS5 全文検索（[retrieval](retrieval.md) の search service を薄くラップ）。

引数（Zod）:

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `query` | `string`（min 1） | （必須） | 検索文字列 |
| `sourceType` | `string`（min 1） | （任意） | `source_type` 完全一致で絞る |
| `observedAfter` | `iso` | （任意） | `observed_at` 下限（inclusive `>=`） |
| `observedBefore` | `iso` | （任意） | `observed_at` 上限（exclusive `<`） |
| `limit` | `int > 0` | `20` | 返す最大 hit 数 |
| `fullBody` | `bool` | `false` | excerpt ではなく全文 `body` を返す（既定は excerpt のみ・全文は `source.get` に委譲、[ADR-0018](../adr/0018-knowledge-graph-traversal.md) payload 抑制・retrieval-m2） |
| `maxBodyChars` | `int > 0` | `240` | hit ごとの excerpt 最大文字数 |

フィルタは FTS / 短クエリ LIKE fallback の両経路に同一適用され、未指定時は従来結果と一致する（additive、#142）。

戻り値:

```jsonc
{
  "hits": [
    {
      "externalId": "gh:1",      // connector 付与 id（ADR-0007）
      "sourceType": "github_issue",
      "observedAt": "2026-06-14T00:00:00.000Z",
      "score": -1.43,             // bm25（昇順=より関連）。fallback 時は token 出現回数（多いほど関連）
      "excerpt": "…match 周辺…"    // 既定の上限付き excerpt（[ADR-0018](../adr/0018-knowledge-graph-traversal.md) payload 抑制・retrieval-m2）。fullBody 指定時は代わりに "body"（全文・ADR-0003）
    }
  ],
  "strategy": "fts",              // "fts" | "like-fallback"（短クエリは後者）
  "totalHits": 5,                 // limit 適用前の総マッチ数（>= hits.length）
  "truncated": false,             // limit で打ち切られたか（totalHits > hits.length）
  "analyzedQuery": ["rocket"]     // 実際に検索に使われたトークン（FTS / fallback とも whitespace 分割）
}
```

- `totalHits` / `truncated` は「20/20 打ち切り」と「5/5 完全」をエージェントが区別するための透明性フィールド（ADR-0007「no silent wrong answer」）
- `analyzedQuery` は FTS / LIKE fallback とも whitespace 分割トークン（fallback も per-token AND のため）。痩せ/空結果の原因（何が検索されたか）を可視化する
- **payload 抑制（retrieval-m2）**: 既定は全文ではなく hit ごとの上限付き `excerpt`（既定 240 code point）。lexical hit はマッチ位置中心、recall は先頭 N chars を切り出す。全文は `source.get` に委譲し、`fullBody: true` で `body`（全文）、`maxBodyChars` で excerpt 長を上書き（[ADR-0018](../adr/0018-knowledge-graph-traversal.md) の payload 抑制原則を search に適用）
- ランキング・短クエリ fallback・クエリエスケープの詳細は [retrieval](retrieval.md) を参照
- 意味検索が要るケースは 意味検索（embedding 有効時）へ

### `search（mode=semantic）`（意味検索・graceful degradation・ADR-0005）

引数は `search` と同じ（`query` / `sourceType?` / `observedAfter?` / `observedBefore?` / `limit` / `fullBody?` / `maxBodyChars?`）。embedding backend が有効なときは query を埋め込み、`vec0` の KNN で最近傍 source を引いて `search` と同形の hits を返す（`strategy` は無く、`score` は L2 distance ＝ 小さいほど近い・best-first）。hits も `search` と同様、既定は上限付き `excerpt`（recall は先頭 N chars）で `fullBody` / `maxBodyChars` に対応する（retrieval-m2）。`sourceType` / `observed*` フィルタは JOIN 済み `sources` 行への post-filter で適用する（KNN は多めに引いてから絞る、#142）。詳細は [retrieval](retrieval.md)。

成功時の戻り値は `{ "hits": [...], "truncated": bool }`。`truncated` は `limit` で最近傍リストが打ち切られたか（`limit + 1` 件プローブで判定）で、FTS の `truncated` と同じ「full page = 完全と決めつけない」透明性シグナル（ADR-0007、[#565](https://github.com/ozzy-labs/suasor/issues/565)）。**`totalHits` は無い**: KNN は全 embedded source を距離順に並べるため「limit 適用前の総マッチ数」が match count として意味を持たない。`reason` は degrade 時のみ（成功時には現れない）。

graceful degradation（host は常に `signal === "embedding_disabled"` だけで FTS フォールバックを判断できる）:

- `[embedding].backend = "disabled"`（既定）/ 外部 backend（openai・voyage）の API キー未設定 → `{ "hits": [], "truncated": false, "signal": "embedding_disabled", "reason": "backend_disabled" }`
- backend 有効だがサイドカー / 外部 API 到達不能（Ollama down・API エラー等）→ `{ "hits": [], "truncated": false, "signal": "embedding_disabled", "reason": "backend_unreachable" }`

`reason` は診断用の補助（host は `signal` を見る）。ingest 時の文書 embedding と query embedding は同一モデルで、`[embedding].model` が両者を駆動する（[config](config.md) / [retrieval](retrieval.md)）。

### `search（mode=hybrid）`（確定・read・RRF 融合・#142）

`search`（FTS）と 意味検索（vec）を**両方走らせ**、2 つのランク済みリストを Reciprocal Rank Fusion（RRF）で融合する read tool。lexical（完全一致）と semantic（言語跨ぎ・語彙ミスマッチ）の盲点を相互補完する。FTS-first（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）を保ったままの additive 拡張で、新 ADR は不要（融合方式の詳細は [retrieval](retrieval.md) の Hybrid 節）。

引数（Zod）: `search` と同じ（`query` / `sourceType?` / `observedAfter?` / `observedBefore?` / `limit` / `fullBody?` / `maxBodyChars?`）。フィルタ・limit・body 射影は両経路に適用される。

戻り値:

```jsonc
{
  "hits": [
    {
      "externalId": "gh:1",
      "sourceType": "github_issue",
      "observedAt": "2026-06-14T00:00:00.000Z",
      "score": -1.43,            // 代表 hit の元 score（FTS=bm25 / vec=L2）
      "excerpt": "…match 周辺…",  // 既定の上限付き excerpt（fullBody 指定時は代わりに "body" 全文・retrieval-m2）
      "rrfScore": 0.0328         // RRF 融合スコア（降順=より関連、best-first）
    }
  ],
  "truncated": false,            // いずれかの経路が limit で打ち切られた / 融合後の union が limit を超えた（#565）
  "signal": "embedding_disabled" // embedding 無効/未到達で FTS のみに degrade した場合のみ
}
```

- **融合**: 各リストの 0-based rank に `1 / (k + rank)`（`k` 既定 60）を寄与とし `externalId` ごとに合算。両リストにヒットした文書は両寄与を得て上位化。重複 `externalId` は dedup（両側に居れば FTS 側 hit を代表とし lexical の `excerpt` / `body` / `score` を保持）。同点は `externalId` 昇順で決定的
- **graceful degrade**: embedding 無効 / サイドカー到達不能のときは FTS のみで融合（実質パススルー）し、`mode=semantic` と同じ `embedding_disabled` シグナルを付与する（hard error にしない）
- **透明性（[#565](https://github.com/ozzy-labs/suasor/issues/565)）**: `truncated` は「FTS 側が打ち切り or vec 側が打ち切り or 融合後 union > limit」のいずれかで `true`（capped vs complete のシグナルが融合を生き延びる）。**`totalHits` は無い**: fetch したページの外にある union の真のサイズは知り得ない

### `source.list` / `source.get`

- `source.list`: `sourceType?: string` / `observedAfter?: iso` / `observedBefore?: iso` / `limit?: int` / `fullBody?: bool` / `maxBodyChars?: int` → `{ "sources": [...] }`（`observed_at` DESC）。各 source は `externalId` / `sourceType` / `fingerprint` / `observedAt` / `meta` に加え、既定は上限付き `excerpt`（`search` と同じ payload 抑制・[ADR-0018](../adr/0018-knowledge-graph-traversal.md)・[#564](https://github.com/ozzy-labs/suasor/issues/564)）。`fullBody: true` で代わりに `body`（全文）、`maxBodyChars` で excerpt 長を上書き。全文は `source.get` に委譲。
- `source.get`: `externalId: string`（min 1）→ `{ "source": {...} | null }`（本文込み、無ければ `null`）。

### `source.get`（`include`）（確定・read・#279）

source の metadata + body・**outgoing** provenance links・extraction_meta sidecar を 1 コールでバンドルする read tool（実体は `src/mcp/queries.ts` の `getSourceFull`、`readOnlyHint: true`）。従来は `source.get` + `graph.related(direction=out)` + 抽出 sidecar 参照の 3 往復が必要だった read パターンを 1 往復に畳む。実装は既存 query 層の再利用（`getSource` + `listLinks(direction=out)` + `getExtractionMeta`）で、graph entity は `(kind=source, id=externalId)` として扱う。

引数（Zod）: `externalId: string`（min 1）/ `include?: ("links" | "extraction")[]`（既定: なし = source のみ。`links` で outgoing provenance links、`extraction` で extraction_meta sidecar を同一往復にバンドル）。

戻り値: `{ "source": {...} | null, "links"?: [{ kind, id, relation, direction, linkId? }], "extractionMeta"?: { version, state, updatedAt } | null }`（`links` / `extractionMeta` は `include` で要求した section のみ現れる）。`links` は source を `from` とする outgoing edge のみ（`graph.related` と同形）。`extractionMeta` は抽出されていない source（プレーンテキスト connector 本文等）では `null`（[ADR-0024](../adr/0024-document-extraction-sidecar.md)）。未知 id は `source: null` + 要求 section 空（エラーにしない）。副作用なし。

### `source.history`（確定・read・#121）

source の本文版を **event log から**新しい順に返す read tool（実体は `src/mcp/queries.ts` の `listSourceHistory`、`readOnlyHint: true`）。`source.get` が projection の**現本文のみ**を返すのに対し、`source.history` は append-only `events` の `SourceObserved` / `SourceBodyUpdated`（いずれも全文 `body` を保持、[ADR-0002](../adr/0002-event-sourced-architecture.md)）を `json_extract(payload,'$.externalId')` で引き、真の before/after 差分を可能にする（`source-review` skill が使う）。

引数（Zod）: `externalId: string`（min 1）/ `limit?: int`（新しい順・既定 50）。

戻り値: `{ "versions": [{ "observedAt", "fingerprint", "body", "recordedAt" }] }`（`recorded_at` DESC＝最新が先頭）。該当なしは `[]`。副作用なし（`events` の SELECT のみ）。

### `task.list` / `decision.list` / `inbox.list`

projection 一覧。いずれも `limit?: int`、最近更新順（対象列 DESC）。

| tool | 追加引数 | 時間窓の対象列 | 戻り値キー |
|---|---|---|---|
| `task.list` | `state?: "proposed"\|"open"\|"in_progress"\|"completed"\|"dropped"` / `dueBefore?: string` / `dueWithinDays?: int` / `overdue?: bool`（[ADR-0028](../adr/0028-task-scheduling-fields.md)） | `updated_at`（`updatedAfter` / `updatedBefore`） | `{ "tasks": [...] }` |
| `decision.list` | （なし） | `recorded_at`（`recordedAfter` / `recordedBefore`） | `{ "decisions": [...] }` |
| `inbox.list` | `state?: "open"\|"snoozed"\|"done"\|"dismissed"` / `sourceType?: string` | `updated_at`（`updatedAfter` / `updatedBefore`） | `{ "items": [...] }` |

`task.list` の各 task レコードは `dueDate` / `priority`（low / normal / high・null 可）と、read 時派生の `overdue`（`dueDate < now AND state ∈ {open, in_progress}`、[ADR-0028](../adr/0028-task-scheduling-fields.md)）を持つ。`dueBefore` は `due_date < ?` で絞り（null due は除外）、`dueWithinDays: N` は「今日/今週の優先」観点で `due_date < now + N 日`（上限 exclusive、null due 除外）に絞る（`now` は overdue と同じく注入可能で決定論的）、`overdue: true` は overdue な task のみに絞る。overdue は projection に焼かず read 時に計算する（`now` は決定論テスト用に注入可能、replay 不変性を保つため・[ADR-0002](../adr/0002-event-sourced-architecture.md)）。

`inbox.list` の `sourceType` は inbox projection に `source_type` 列が無いため `sources` を JOIN して解決する（`sources.external_id = inbox.source_external_id`）。「inbox の中で slack_message だけ」のように元 source 種別で絞れる。

### `demand.list`（[ADR-0041](../adr/0041-neutral-demand-priority-substrate.md)、旧 `slack.demand.list` を置換）

取り込み済み source から **query 導出**する connector 中立 demand（追加 fetch なし、新規 projection なし）:

- **Slack**（`source: "slack"`）: `source_type='slack_message'` かつ（DM = channel id が `D` 始まり）または（mention = `body LIKE '%<@uid>%'`）。`kind: "mention"|"dm"`。`channelName` / `userName` / `teamName` をローカル projection から join（[ADR-0037](../adr/0037-slack-name-enrichment.md)、live fetch なし）。
- **GitHub**（`source: "github"`）: `source_type='github_notification'` かつ `meta.reason` が demand 相当（`review_requested` / `mention` / `team_mention` / `assign` / `author`）。`kind` = その reason。slack enrichment は `null`。
- **Email**（`source: "email"`）: 自分宛て（To/Cc）かつ未返信のスレッド代表 1 行。`kind: "to"|"cc"`（[ADR-0043](../adr/0043-email-demand-signals.md)、後述）。
- **Calendar**（`source: "calendar"`）: `meta.start` と注入可能な `now` から**read 時に派生**する近接予定。`kind: "meeting_soon"`（開始 120 分以内）/ `"meeting_prep"`（24 時間以内かつ議題・添付・自分が organizer のいずれか）（[ADR-0044](../adr/0044-calendar-proximity-signals.md) 決定 3/4、後述）。

**seen-state**（ADR-0041、ADR-0012 決定 4 を supersede）: 既定は **未処理（un-acked）のみ**返す。`demand.mark`（`state`）（write）で `demand_seen` に印を付けた行、および GitHub 側で既読の notification（`meta.unread=false`）は既定で除外され「未処理」が真になる。`includeSeen: true` で全件を `seenState`（`acked` / `dismissed` / `read` / null）付きで返す。

| 追加引数 | 時間窓の対象列 | 戻り値キー |
|---|---|---|
| `selfUserId?: string`（slack mention 用、未指定時は config の `self_user_id`）/ `source?: "slack"\|"github"\|"email"\|"calendar"` / `kinds?: DemandKind[]`（enum: slack `mention`/`dm`、github reason（`assign`/`author`/`mention`/`review_requested`/`team_mention`）、email `to`/`cc`、calendar `meeting_soon`/`meeting_prep`。範囲外はスキーマエラー）/ `includeSeen?: boolean` / `fullBody?: boolean` / `maxBodyChars?: int` | `observed_at`（`observedAfter` / `observedBefore`） | `{ "demand": [{ ..., "source", "kind", "seenState" }], "truncated" }` |

`selfUserId` も config も無いと slack mention は無効化され DM のみ返す（`kinds: ["mention"]` 指定時は github mention notification のみ）。

各行は既定で上限付き `excerpt`（全文 `body` ではない）を返す（`search` / `source.list` と同じ payload 抑制・[ADR-0018](../adr/0018-knowledge-graph-traversal.md)・[#564](https://github.com/ozzy-labs/suasor/issues/564)）。`fullBody: true` で全文、`maxBodyChars` で excerpt 長を上書き。全文は `source.get` に委譲。

**並び順**: calendar 行が**開始時刻の昇順で先頭**、続いて他 source が `observed_at` の降順。鮮度と近接は別軸であり、1 つのキーに畳むとどちらかを誤って報告する。calendar を先頭に置くのは、`limit` の打切りが「20 分後に始まる会議」を落とさないようにするため。

### `priority.list`（[ADR-0041](../adr/0041-neutral-demand-priority-substrate.md) 決定 3）

決定論的 cross-entity scorer。open/in_progress な tasks + open commitments + un-acked demand を**固定 comparator**で 1 本のランク付きリストに合成する（実体は `src/mcp/queries.ts` の `buildPriorities`、`readOnlyHint: true`）。順位の基線はコードが持ち（skill 散文ではない）、同一入力に対し順序が一定になる（テストで固定）。

順序モデル（[ADR-0045](../adr/0045-priority-ranking-model.md)）: **hard tier 1 つ + 重み付きスコア**。hard tier は「開始 30 分以内の会議」のみ（壁時計が他のすべての考慮を無効化する唯一の領域・[ADR-0044](../adr/0044-calendar-proximity-signals.md) の calendar demand で有効。tier は**順序の上書き**であってスコアの代替ではないので、hard tier の行も `prep` と同じ連続スコアを持つ）。それ以外は `overdue`（超過日数）/ `aging`（未返信日数・[ADR-0043](../adr/0043-email-demand-signals.md)）/ `unacked_demand`（鮮度）/ `due_soon`（期日接近）/ `prep`（会議準備）/ `priority` を**重み付きで合成した単一スコア**で比較する。

**tier ラダーからスコアへ移した理由**は程度を比較できなかったこと — 旧実装では「1 日超過」と「3 週間超過」が同格で、`starting_soon` の窓が 120 分だったため **110 分後の会議が 3 週間放置のタスクより上**に出ていた。またスコアなら、mention の鮮度（新しいほど高い）とメールの未返信日数（古いほど高い）という**逆符号の時間項**が 1 本のモデルに共存できる（tier では 2 段必要だった）。

重みは**コード内定数**（config 化しない・[ADR-0045](../adr/0045-priority-ranking-model.md) 決定 3）。各項は飽和点を持ち（例: 超過 30 日で頭打ち）、1 件の長期放置が他を永久に押し下げない。**期限を跨いでもスコアは下がらない**（`overdue` の下限 > `due_soon` の上限）。

各行は `reason`（**最も寄与した項**）+ `explanation`（その項の一文・例「期限を 21 日超過」）+ `score`（総スコア）+ `record` を持つ。**表示の主役は `explanation` であって数値ではない**（決定 4）。ack 済み mention は demand から外れるため、期日付き作業の上に居座り続けることはない。`next-actions` / `brief` はこの基線を消費する（会話文脈での上書きは host の裁量）。

| 追加引数 | 戻り値キー |
|---|---|
| `selfUserId?: string`（demand mention 用、未指定時は config）/ `limit?: int`（既定 50） | `{ "now", "items": [{ "rank", "entity": "task"\|"commitment"\|"demand", "id", "title", "reason", "explanation", "overdue", "dueDate", "priority", "record" }], "truncated" }` |

### `graph.related` / `graph.expand`（[ADR-0018](../adr/0018-knowledge-graph-traversal.md) / [ADR-0020](../adr/0020-multi-actor-coordination-scope.md)）

既存 `links` projection 上の provenance traversal。`graph.related` は origin の 1-hop 隣接、`graph.expand` は depth/limit で束ねた BFS 展開を返す。relation は自動エッジ `derived_from` / `replies_to` / `references` と手動エッジ `manual_link`（#90、手動 link は `linkId` 付き）。本文は `source.get` で取得する。

| tool | 引数 | 戻り値キー |
|---|---|---|
| `graph.related` | `kind` / `id` / `direction?: "out"\|"in"\|"both"`（既定 `both`） / `relation?` | `{ "origin", "neighbors": [{ kind, id, relation, direction, linkId? }] }` |
| `graph.expand` | `kind` / `id` / `depth?`（既定 2、max 10） / `direction?: "out"\|"in"\|"both"`（既定 `both`） / `limit?` | `{ "origin", "nodes": [...], "edges": [{ from, to, relation }] }` |

`direction`（[ADR-0020](../adr/0020-multi-actor-coordination-scope.md)）は各 hop で辿る辺の向きを絞る。既定 `both` は従来挙動（後方互換）。`in` は **incoming のみ**を遡る後方 provenance トレース（opshub `graph trace` 相当 = 「この成果物は何に由来するか」）、`out` は下流の consumer 展開。cycle guard（visited-set）と edge dedup（seenEdges）は direction 適用後も維持する。新ツールは増やさず `graph.expand` の 1 パラメータ追加で表現する（ADR-0020 §決定 3）。

### `person.list`（[ADR-0022](../adr/0022-person-identity-resolution.md)）

解決済み person を新しい更新順（`updated_at` DESC）に列挙し、各 person に紐づく `(connector, handle)` identity を添えて返す read tool（実体は `src/mcp/queries.ts` の `listPersons`、`readOnlyHint: true`）。connector author handle が初期は **1 handle = 1 person** で投影され（自動 fuzzy 同定なし）、operator が `person.merge` / `person.split` で重複を統合する。

| 追加引数 | 戻り値キー |
|---|---|
| `includeEmpty?: boolean`（merge で identity が 0 になった person を含めるか。既定 `false`） | `{ "persons": [...], "truncated", "duplicateCandidates": [{ "normalizedName", "persons": [{ "id", "displayName", "identityCount" }] }] }` |

merge で空になった person は既定で除外（`identity_count > 0`）。`includeEmpty: true` で tombstone も列挙できる。

**`duplicateCandidates`**（[#443](https://github.com/ozzy-labs/suasor/issues/443)）は display name を正規化（NFKC + 小文字化 + 空白畳み）して衝突した person の組。`person.merge` は存在するのに「統合すべきものがある」と**誰も言わない**ため、台帳が `Tanaka` と `TANAKA`（末尾空白）に割れたまま放置される — その欠落を埋める提示。**自動 merge は決してしない**（同名の別人は実在し、誤統合は他人の約束・mention を自分に紐づける）。検出は決定論（正規化一致のみ・類似度モデルではない、[ADR-0006](../adr/0006-ml-delegation.md)）で、運用者が一目で検証できる事実に限る。

### `brief`（[ADR-0017](../adr/0017-brief-period-bundle.md)）

期間バンドルを 1 round-trip で返す read tool（実体は `src/mcp/queries.ts` の `buildBrief`、`readOnlyHint: true`）。各 section は自然な timestamp 列で期間フィルタする（`sources`=observed / `tasks`=updated / `decisions`=recorded）。`inbox` だけは「現在 open」（期間非依存）。既定 window は直近 24h。本文を持つ section（`sources` / `demand`）の各行は既定で上限付き `excerpt`（全文 `body` ではない）を返す（`search` と同じ payload 抑制・[ADR-0018](../adr/0018-knowledge-graph-traversal.md)・[#564](https://github.com/ozzy-labs/suasor/issues/564)）。`fullBody: true` で全文、`maxBodyChars` で excerpt 長を上書き。全文は `source.get` に委譲。

戻り値:

```jsonc
{
  "window": { "since": "...", "until": "..." },
  "sources": [/* SourceRecord（既定は body の代わりに上限付き excerpt・#564） */],
  "tasks": [/* TaskRecord */],
  "decisions": [/* DecisionRecord */],
  "inbox": [/* InboxRecord（state=open） */],
  "demand": [/* DemandRecord（un-acked のみ・ADR-0041。既定は excerpt・#564） */],
  "commitments": [/* CommitmentRecord（open のみ・緊急度順・#513） */],
  "truncated": {                      // section ごとの打切りフラグ（ADR-0007）
    "sources": false, "tasks": false, "decisions": false, "inbox": false, "demand": false,
    "commitments": false
  },
  "warnings": [                       // 完全性シグナル（Issue #189）
    { "key": "slack_not_configured", "message": "Slack connector not configured — ..." },
    { "key": "embedding_disabled",  "message": "embedding backend off — ..." }
  ]
}
```

`commitments`（open のみ・**非時間軸**＝inbox と同じ扱い。[#513](https://github.com/ozzy-labs/suasor/issues/513)）は、期限を過ぎた約束が窓の外で結ばれたからといって重要でなくなるわけではないため時間フィルタを掛けない。並びは緊急度順（[#509](https://github.com/ozzy-labs/suasor/issues/509)）なので、打切られても催促すべき行が先頭に残る。**以前は bundle から丸ごと欠落しており、生の `brief` を読む host は「誰に何を負っているか」を静かに落としていた。**

`truncated`（section ごとの打切りフラグ・[ADR-0007](../adr/0007-connector-contract.md) の "no silent wrong answer"）は、各 section が `limit`（既定 50・DEFAULT_LIST_LIMIT）で打ち切られたかを示す。list 系 tool の `truncated`（boolean）と同じ規律を、複数 section を束ねる brief では section 単位で返す（各 section を `limit + 1` で probe し、超過していれば切り詰めて `true`）。`true` の section は多忙な日にバンドルが黙って過小申告している合図なので、host は window（`since` / `until`）を狭めるか、対応する list tool（`source.list` / `task.list` / `decision.list` / `inbox.list` / `demand.list` / `commitment.list`）でページングする。後方互換の additive field。

`warnings`（完全性シグナル・Issue #189）は、**未設定が理由で空になった category** を区別するための注記。空 section が「本当に何も無い」のか「source 未接続だから空」なのかを host が判別できる。`buildBrief` 自体は純粋（config を知らない）で、呼び出し側（CLI / MCP server）が config から導出して渡す（`deriveBriefWarnings`）。設定済みなら空配列。

- `slack_not_configured`: `[connectors.slack]` が未設定（`self_user_id` の有無とは独立）。`demand` が常に空になる。
- `embedding_disabled`: `[embedding].backend = "disabled"`。recall 由来の素材が FTS-only に劣化する。
- `sync_stale`: 有効な connector の取り込みが遅れている（[#442](https://github.com/ozzy-labs/suasor/issues/442)）。メッセージは遅れている connector と理由（`slack (120h old)` / `github (never synced)` / `google (last run failed)`）を並べる。**空の bundle が「静かな週」なのか「止まった pipeline」なのかを区別する**ための signal で、他 2 つと違い config だけでなく `sync_runs` から read 時に導出する（`deriveSyncFreshness`）。

CLI（`suasor brief`）はヘッダに `[⚠ <key>, ...]` を付記し、`--json` では同じ `warnings` 配列をバンドルに含める。

> **`bodyDroppedAt`**（[#498](https://github.com/ozzy-labs/suasor/issues/498) / [ADR-0047](../adr/0047-storage-lifecycle.md)）: retention が本文を落とした時刻。`null` なら本文は健在。**非 null + 空 `body` は「storage を抑えるために削除した」であって「本文が元々無い」ではない** — 空文字だけを黙って返すのは [ADR-0007](../adr/0007-connector-contract.md) の "no silent wrong answer" に反するため明示する。メタデータ・provenance link・embedding は残っているので、source 自体は引き続き発見できる。
>
> **`source.list` の `startsAfter` / `startsBefore`**（[ADR-0044](../adr/0044-calendar-proximity-signals.md) 決定 2 / [#490](https://github.com/ozzy-labs/suasor/issues/490)）: calendar event の**自身の開始時刻**（`meta.start`）に対する窓。`observedAfter` / `observedBefore` は**更新時刻**の窓であり、「来週の会議」をそちらで引くと**別の問いに答える**（最近編集された予定が返る）。`meta.start` を持たない行は除外。
>
> **email demand**（[ADR-0043](../adr/0043-email-demand-signals.md) / [#488](https://github.com/ozzy-labs/suasor/issues/488)）: `demand.list` の `source` に `email` が加わった（gmail / outlook 双方。ユーザーの心的モデルは「メール」であり、由来は `sourceType` に残る）。**スレッド単位**で、自分宛て（To/Cc）かつ**未返信**の最新 inbound 1 行が代表。`kind` は `to` / `cc`。
>
> **返信すれば ack なしで消える**（自分の返信が sync で入ると述語が破れる）。**新着で再浮上する**（代表行が変わる）。newsletter は `List-Id` / `List-Unsubscribe` という**機械的事実**で除外し、bcc / 配信は「To/Cc に自分がいる」条件で構造的に除外する。`self_addresses` 未設定なら**常に空**（`doctor` が警告する）。
>
> ランキングでは `to` のみが **aging**（古いほど高い）で、`cc` は mention と同じく減衰する（[ADR-0045](../adr/0045-priority-ranking-model.md)）。
>
> **calendar demand**（[ADR-0044](../adr/0044-calendar-proximity-signals.md) / [#490](https://github.com/ozzy-labs/suasor/issues/490)）: `source` に `calendar` が加わった（google / outlook 双方）。`meeting_soon`（≤120 分）と `meeting_prep`（≤24 時間 かつ 議題 or 添付 or organizer）の**窓を分ける**のが要点で、準備は前夜に出ないと行動できず、出席の催促は 24 時間前では邪魔になる。両方に該当する予定は `meeting_soon` として 1 行のみ。
>
> 除外は **`declined`**（明示的な意思表示を覆さない）/ **optional・非参加者**（最上位が任意参加で埋まる）/ **終日予定**（00:00 開始に近接の意味が無い）。**ack 不要で、開始すれば窓から外れる**（`demand.mark` は「準備済み」の脱出口として引き続き有効）。
>
> ランキングでは開始 **30 分以内**のみが hard tier（`starting_soon`）で、それ以外は `prep` 項として 24 時間で 0 になる連続スコアになる（[ADR-0045](../adr/0045-priority-ranking-model.md) 決定 1 が ADR-0044 決定 5 の 2 tier 案を改訂）。**`brief` は calendar demand を含まない** — brief は「窓」の束であり、窓の対象列は更新時刻なので、含めると「先週編集された予定」を答えてしまう。

### `sync.status`（確定・read・#442）

取り込み鮮度の read tool（`readOnlyHint: true`）。`sync_runs`（[ADR-0033](../adr/0033-sync-run-history.md)）は全 run を記録してきたが、読むのは `suasor sync status` だけで、**エージェントには自分のデータが止まっていることを知る手段が無かった** — PATH の通らない cron 行に凍結された store から、自信を持って先週の答えを返してしまう。

引数（Zod）: `staleOnly?: boolean`（`ok` 以外だけ返す）。

戻り値: `{ runs, freshness, stale }`。

- `runs` — connector 別の最新 run（`listSyncRuns` そのまま）
- `freshness` — connector ごとの判定（`ok` / `stale` / `never` / `failing`）+ `lastSyncAt` / `ageHours` / `thresholdHours` / `detail`
- `stale` — `ok` でない connector 名の配列（`staleOnly` の有無に関わらず全件）

判定は **read 時派生**（`now` 依存の状態を projection に焼かない — [ADR-0028](../adr/0028-task-scheduling-fields.md) の overdue と同型）。閾値は `[sync]` config（既定 24h × 2）。`[sync]` を渡さない embed では `freshness` / `stale` は `null`（**判定を捏造しない**）。同じ導出関数を `doctor` の `sync.freshness` チェックと brief の `sync_stale` warning が共有するので、3 経路の見解が食い違うことはない。

### `activity.timeline`（確定・read・#279）

entity 軸の時系列ビューを返す read tool（実体は `src/mcp/queries.ts` の `buildActivityTimeline`、`readOnlyHint: true`）。`brief` が**期間軸**（その期間に何が動いたか）なのに対し、`activity.timeline` は**entity 軸**（その entity の周りで何が起きたか）で対をなす。起点 entity（kind + id — person / project / source 等）から `links` provenance graph を辿り（`expandGraph`、direction=both）、到達した source / task / decision を既存 query 層（`getSource` / `getTask` / `getDecision`）で引き、各々の自然な timestamp（source=observed / task=updated / decision=recorded）を `at` に刻んでマージ→新しい順 sort→`limit` で cap する。起点 entity 自身も timeline 種別なら含む。純粋 SELECT。

引数（Zod）: `kind: string`（min 1）/ `id: string`（min 1）/ `depth?: int`（1–10・既定 2）/ `after?: iso`（各 item の `at` 下限 inclusive `>=`）/ `before?: iso`（同上限 exclusive `<`）/ `limit?: int`（新しい順・既定 50）。

戻り値: `{ "origin": { kind, id }, "window": { since, until }, "items": [{ kind: "source"|"task"|"decision", id, at, record }] }`。`record` は各 kind の projection レコード（SourceRecord / TaskRecord / DecisionRecord）。接続 activity が無い entity は `items: []`。

**完全性の境界**: graph walk は `depth` と内部の graphLimit（既定 `max(limit*4, 50)`）で打ち切る。打ち切りは BFS（hop 距離）順で newest-first sort の**前**に起こるため、到達ノード数が graphLimit を超える dense な entity では「より新しいが遠い（hop が多い）」item が落ちうる。newest-first 保証は graph 到達可能な部分集合内でのみ成り立つ。疎で遠い provenance を網羅したい場合は `depth` を上げる。

### catchup（「前回以降の差分」）のバックエンド方針（レビュー D1 確定）

assistant skill カタログ（[ADR-0008](../adr/0008-assistant-skills.md)）のうち、catchup 挙動 —「前回以降の差分」「久しぶりに確認」。旧 `catchup` skill、[ADR-0046](../adr/0046-agent-surface-contraction.md) で `brief` に統合 — だけが専用 MCP tool を持たない。**専用 tool は追加しない**。この挙動は既存の read tool（`source.list` / `task.list` / `decision.list` / `inbox.list`）を、**host 側で保持する seen-marker（最終確認時刻）+ 各 tool の時間フィルタ**（`*After` / `*Before`）で合成して差分を組み立てる方式を既定とする。

- marker は host（Claude Code 等）側に保持する。server は永続 marker を持たない（local-first / stateless read surface を保つ）。
- 上記 4 tool が下限 inclusive の時間フィルタを備えているため、`since = last_seen` を各 `*After` に渡すだけで「前回以降の差分」を合成できる。
- server 側に永続 marker が必要と判断された場合に限り、別 Issue で catchup 用 read tool（since-marker 差分 + marker 更新）を追加する。本 Issue の scope では追加しない。

## Write tools（HITL・人の承認なしに適用/送信しない）

write tool は HITL（auto-apply 経路を持たない）。`readOnlyHint: false` を付け、ホストは人の承認なしに呼ばない。いずれも writable store 供給時のみ登録される（`src/mcp/server-write.ts`）。**HITL は host 強制**である —— `readOnlyHint: false` は advisory な annotation で、server 自身は承認の有無を検査せず handler を実行する（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) の Negative）。defense-in-depth として、不可逆 / egress の部分集合（`source.forget` / `propose.apply` の `publish:true` / `task.publish` / `task.act` / `person.merge`）は **client が elicitation capability を advertise する場合にのみ** `elicitInput` 確認往復を挟み、却下時は `CONFIRMATION_DECLINED` を返す（capability 非対応なら現行動作にフォールバック + 接続時警告。実体は `src/mcp/elicit.ts`）。これは server 強制の保証ではない（elicitation 応答も client 側で生成される）。

| tool | 役割 | 状態 |
|---|---|---|
| `connector.sync` | 取り込み実行 | 実装済み（#10。下記参照） |
| `propose.generate` | 返信/タスク/決定/仕分け/commitment の候補生成（mode 引数: `reply_draft` / `source_extract` / `meeting_followup` / `inbox_triage` / `commitment_scan`）。候補を `proposals` ledger に `pending` 記録 | 実装済み（#12 / #89 / #91。下記参照） |
| `propose.apply` | 承認された候補のみ適用（idempotent）。適用で ledger を `applied` に遷移。任意 `publish:true` で適用した task 候補を既定ホーム（`[tasks].default`）へ起票（ADR-0036・best-effort per task・`openWorldHint:true`・失敗は `published[]` に集約し throw しない） | 実装済み（#12 / #89 / ADR-0036。下記参照） |
| `propose.reject` | pending 候補を理由付きで却下（ledger を `rejected` に遷移、idempotent） | 実装済み（#89。下記参照） |
| `propose.batch` | apply / reject を 1 RPC・単一トランザクションで一括処理（atomic、apply/reject ロジック再利用） | 実装済み（#197。下記参照） |
| `proposal.feedback` | pending 候補に「修正して再生成」用の reason を記録（state は `pending` のまま、次 generate のヒント） | 実装済み（#279。下記参照） |
| `task.create` | task 直接追加（ホスト側で人確認を促す） | 実装済み（#12。下記参照） |
| `task.update` | task の lifecycle 状態遷移（open / in_progress / completed / dropped） | 実装済み（下記参照） |
| `task.publish` | task を外部ホーム（GitHub Issues（任意で Projects v2 board）/ Jira / Slack List）へ起票。行き先は任意 `destination` 引数 or `[tasks].default`（egress・`openWorldHint: true`・[ADR-0036](../adr/0036-task-external-home.md) R1-2） | 実装済み（下記参照） |
| `task.act` | 公開済み task への状態操作を外部ホームへ発行（complete / reopen / comment・egress・`openWorldHint: true`）。config は task 自身の `published_destination` で解決（R1-3） | 実装済み（下記参照） |
| `decision.record` | decision 直接記録（人自身の「これを決定として」経路） | 実装済み（#88。下記参照） |
| `inbox.add` | 受信箱項目を捕捉（state `open`） | 実装済み（#88。下記参照） |
| `inbox.triage` | open 項目を task 化 / decision 化 / discard に遷移（state machine） | 実装済み（#88。下記参照） |
| `link.add` | 2 エンティティ間に手動 link を作成（relation `manual_link`） | 実装済み（#90。下記参照） |
| `link.remove` | 手動 link を id 指定で削除（event・監査可能） | 実装済み（#90。下記参照） |
| `commitment.set`（`state="resolved"`） | open の commitment を fulfilled に遷移（[ADR-0021](../adr/0021-commitment-ledger.md)） | 実装済み（#91。下記参照） |
| `commitment.set`（`state="dismissed"`） | open の commitment を誤検出/不要として却下 | 実装済み（#91。下記参照） |
| `commitment.set`（`state="open"`） | resolved/dismissed の commitment を open に戻す | 実装済み（#91。下記参照） |
| `demand.mark`（`state="acked"`） | demand 行を「対応済み」に印（`DemandAcknowledged` → `demand_seen`。既定 demand.list から外れる・[ADR-0041](../adr/0041-neutral-demand-priority-substrate.md)） | 実装済み（#419。下記参照） |
| `demand.mark`（`state="dismissed"`） | demand 行を「対応不要」に印（`DemandDismissed` → `demand_seen`） | 実装済み（#419。下記参照） |
| `person.merge` | 2 person を 1 つに統合（identity を target へ付け替え・可逆） | 実装済み（#92。下記参照） |
| `person.split` | 1 identity を別 person へ分離（merge の逆操作） | 実装済み（#92。下記参照） |
| `draft.export` | 下書きをローカルファイルに書き出す（sandbox・送信しない・[ADR-0025](../adr/0025-local-draft-export.md)） | 実装済み（#133。下記参照） |
| `source.forget` | 取り込み source をローカル purge（redaction + projection 削除 + tombstone・[ADR-0026](../adr/0026-source-forgetting.md)） | 実装済み（#141 / #415。下記参照） |
| `source.unforget` | forget tombstone を解除し再取り込みを再許可（[ADR-0026](../adr/0026-source-forgetting.md) R1-1） | 実装済み（#415。下記参照） |

### `connector.sync`（確定・write / HITL）

connector の read 専用取り込みを起動する write tool（[connector-contract](connector-contract.md) / [ADR-0007](../adr/0007-connector-contract.md)）。store を変更するため write 扱いで、`readOnlyHint: false` を付け、ホストは人の承認なしに呼ばない（auto-apply 経路なし）。CLI `suasor <connector> sync` と**同一の sync service**（`src/connectors/sync.ts` の `syncConnector`）を叩くため、どちらの経路でも取り込み挙動は同一。tool descriptor は `src/connectors/mcp-tool.ts`、server 登録は `src/mcp/server-write.ts`（writable store 供給時のみ登録）。

引数（Zod）:

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `connector` | `string`（必須） | — | 起動する connector 名（例 `github`） |
| `cursor` | `string \| null`（任意） | 省略=前回 cursor から resume | `null` で全件再スキャン |

戻り値:

```jsonc
{
  "connector": "github",
  "observed": 12,    // 新規取り込み
  "updated": 3,      // 本文変更（fingerprint 差分）
  "unchanged": 5,    // 未変更で skip
  "cursor": "2026-06-12T00:00:00Z", // 次回 resume cursor（fingerprint 系は null）
  "embedded": 15,    // vec0 に (再)populate した source 数（embedding 無効時は 0）
  "extracted": 2,    // 本文を抽出テキストに差し替えた source 数（extraction 無効時は 0・ADR-0024）
  "partialFailure": false,  // 内部 sub-unit（例: Slack workspace 1 個）が失敗し他は取り込めた場合 true（#166）
  "summaryLines": ["…"]     // sub-unit ごとの要約行（無ければ省略）
}
```

`[embedding].backend` が有効なとき、新規 / 本文変更 source（`observed` + `updated`）は同一モデルで埋め込まれ vec0 に populate される（意味検索 用、[retrieval](retrieval.md)）。embedding は best-effort で、サイドカー失敗時も取り込み自体は成功する（FTS は反映済み・`embedded` が 0 になるだけ）。

`[extraction].backend` が有効なとき、新規 / 変更された extractable な source（Office/PDF。`local` 先行、API connector は [ADR-0034](../adr/0034-api-connector-extraction.md) で段階展開）は本文がサイドカー抽出テキストに差し替えられる（`extracted`、[ADR-0024](../adr/0024-document-extraction-sidecar.md)）。抽出も best-effort で、unsupported / oversized / 失敗時は name-only に degrade（取り込みは成功）。抽出は fingerprint 確定前・embedding 前に走るため、embedding は抽出テキストを埋め込む。

### propose ライフサイクル（状態機械）

`propose.*` 群は候補の承認/却下 HITL ループを構成する。候補は `proposals` projection（lifecycle ledger）で状態管理され、`propose.list` で状態別に閲覧できる（#89）。

```text
                propose.generate
                      │
                      ▼
   ┌──────────────[ pending ]──────────────┐
   │ propose.apply       ▲ proposal.feedback│ propose.reject
   │ （or batch=apply）   └─ reason 記録・     │ （or batch=reject）
   │                        state 据え置き     │
   ▼                                        ▼
[ applied ]                            [ rejected ]
（domain entity 永続化済み）          （reason 記録・再 apply 不可）
```

- **状態列**: `pending`（生成・人の決定待ち）/ `applied`（人が承認し `propose.apply` で domain entity を永続化）/ `rejected`（人が `propose.reject` で却下、理由付き）。
- **第 3 の選択肢（feedback）**: `proposal.feedback` は pending 候補に reason を記録するが **state は遷移させない**（`pending` のまま）。apply（承認）/ reject（却下）の二択に対し「修正して再生成」のヒントを残す経路（#279）。記録した reason は `propose.list` で読め、次の `propose.generate` の手がかりになる。
- **一括処理**: `propose.batch` は apply / reject を 1 RPC・単一トランザクションで混在処理する（#197）。op ごとの状態遷移・event は `propose.apply` / `propose.reject` と同一で、トランザクション境界だけが 1 つに畳まれる（atomic）。
- **ledger と domain entity の分離**: `propose.generate` は **候補（ledger 行）のみ**を `pending` で記録し、domain entity（task / decision 等）は書かない。entity が永続化されるのは `propose.apply` のときだけ（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) の「提案 → 承認 → 適用」境界を維持）。
- **状態遷移の駆動**: `applied` 遷移は `propose.apply` が append する entity event を reducer が ledger に反映して起こす。task / decision の entity event は `candidateId` を任意フィールドで携行し（#435）、reducer は **`candidate_id` 一致**で該当行だけを `applied` に遷移させつつ、実際に採番された entity id（base または `-N` suffix 付き）を `entity_id` に記録する。`candidateId` を持たない event（`task.create` 等の直接 write・#435 以前の既存 event）は従来どおり **`entity_id` 一致**にフォールバックする（後方互換 replay）。`rejected` 遷移は `ProposalRejected` event。いずれも replay で同一終状態に収束する（[ADR-0002](../adr/0002-event-sourced-architecture.md)）。
- event: `ProposalGenerated`（→ `pending`）/ `ProposalRejected`（→ `rejected`）/ `ProposalFeedback`（pending の `reason` を更新・state 据え置き）。`applied` は既存 entity event の副作用。

### `propose.generate`（確定・write / HITL・[ADR-0006](../adr/0006-ml-delegation.md) ML 委譲）

ホスト LLM が生成した候補（返信下書き / task / decision / 仕分け）を **構造化して候補化**する write tool。実体は `src/propose/generate.ts`。mode ごとの許可 kind に対して候補を検証し、各候補に content 由来の安定 id（`candidateId`）を付与する。**domain entity は永続化しない**が、候補自体は `proposals` ledger に `pending` として記録する（`ProposalGenerated` event、#89）ことで `propose.list` / `propose.reject` の対象になる。重い推論はホスト側で行い、プロセス内で ML を実行しない（[ADR-0006](../adr/0006-ml-delegation.md)）。承認 + 適用は `propose.apply` で別途行う（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。content 由来 id により、同一候補の再 generate は ledger 上 no-op（idempotent）。

引数（Zod）:

| 引数 | 型 | 説明 |
|---|---|---|
| `mode` | `enum`（必須） | `reply_draft` / `source_extract` / `meeting_followup` / `inbox_triage` / `commitment_scan` |
| `candidates` | `Candidate[]`（min 1） | ホストが生成した候補配列 |

候補（`candidates[]`）は `kind` による判別共用体。各 mode が出せる kind は対応するアシスタント skill のフロー（[docs/skills/](../skills/)）に一致する:

| mode | 許可 kind |
|---|---|
| `reply_draft` | `reply_draft` |
| `source_extract` | `task` / `decision` / `reply_draft` |
| `meeting_followup` | `task` / `decision` |
| `inbox_triage` | `task` / `decision` / `triage` |
| `commitment_scan` | `commitment` |

各 kind の形（適用先 event に 1:1 対応）:

| kind | フィールド | 適用先 event |
|---|---|---|
| `task` | `title` / `sourceExternalIds[]` | `TaskProposed` |
| `decision` | `title` / `rationale` / `sourceExternalIds[]` | `DecisionRecorded` |
| `reply_draft` | `replyToExternalId` / `body` | `ReplyDraftProposed` |
| `triage` | `inboxId` / `sourceExternalId` / `state`（`snoozed` / `done` / `dismissed`） | `InboxItemTriaged` |
| `commitment` | `title` / `direction`（`owed_by_me` / `owed_to_me`） / `dueDate?` / `person?` / `sourceExternalIds[]` | `CommitmentOpened` |

戻り値: `{ "mode": "...", "candidates": [{ "candidateId": "cand_...", "kind": "...", ... }], "decided"?: [{ "candidateId": "cand_...", "kind": "...", "state": "applied" | "rejected", "reason"?: "..." }] }`（候補は inert・未適用）。許可されない kind は tool error。`candidates` は **actionable（pending）候補のみ**で、ledger 上すでに `applied` / `rejected` になった候補は `candidates` から除外し、state（+reason）を注記した `decided` に回す（[boundary/missed-reject]）—— ホストが人の決定済み候補を再提示しないため（`decided` が空なら省略）。

### `propose.apply`（確定・write / HITL・idempotent）

承認済み候補を domain event として永続化する write tool（実体は `src/propose/apply.ts`）。各候補は `Store.record` 経由で対応 event を append（append + projection fold が 1 transaction、[ADR-0002](../adr/0002-event-sourced-architecture.md)）。

引数（Zod）: `{ "candidates": Candidate[] }`（`propose.generate` の戻り値の候補。承認分のみ渡す）。

**idempotent（proposal round-trip スコープ、#435）**: 冪等性は **candidateId（提案の round-trip）に限定**する。適用前に proposals ledger を candidateId で参照し、既に `applied` の候補は **event を append せず** `skipped` を返す（entity id は ledger 記録済みの採番値を echo）ため、同じ承認済み集合の再適用は no-op（重複 event / projection drift なし）。同一呼び出し内の重複 candidateId も 1 回だけ append する。`task` / `decision` の entity id は **apply 時に採番**する（`src/propose/identity.ts`）: content 由来の base id（`src/propose/id.ts`）が空いていればそのまま、占有済みなら `-2`, `-3`, … と suffix を進める。これにより同名 task の再来（「経費精算」等）や rationale 違いの同名 decision が、store の寿命にわたって 1 回しか作れない衝突を起こさない（[boundary/propose-1]。decision は rationale も fingerprint に含む）。`reply_draft` / `commitment` は従来どおり entity の存在で判定（content 同一 = 意味同一）し、`triage` のみ `(inboxId, state)` で判定して別 state への遷移は適用する。

**却下の強制（[boundary/missed-reject]）**: apply / batch は適用前に proposals ledger を参照し、candidateId の ledger 行が `rejected` の候補は `REJECTED_CANDIDATE` tool error で拒否する（人の「却下」が下流で無視され、ledger が `rejected` のまま entity が生まれる監査自己矛盾の防止・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。apply は集合全体を事前検査してから 1 件も append しない（部分適用の回避）。batch は単一トランザクション内で throw して全ロールバック（atomic）。ledger 行を持たない候補（純 `proposeGenerate` 産・`task.create` 直挿入）は影響を受けない。

戻り値:

```jsonc
{
  "results": [
    { "candidateId": "cand_...", "kind": "task", "entityId": "task_...", "status": "applied" }
  ],
  "applied": 1,   // append された候補数
  "skipped": 0    // 既存で no-op だった候補数
}
```

適用に伴い、対応する `proposals` ledger 行は `pending` → `applied` に遷移する（#89。reducer 副作用。task / decision は entity event が携行する `candidateId` 一致で該当行のみ遷移 + 採番済み entity id を `entity_id` に記録、その他 kind は `entity_id` 一致・#435）。`task.create` 等 ledger 行を持たない直接 entity 追加では何も遷移しない。

### `propose.list`（確定・read）

提案候補の lifecycle ledger を新しい更新順（`updated_at` DESC）に列挙する read tool（実体は `src/mcp/queries.ts` の `listProposals`、`readOnlyHint: true`）。承認/却下ループの「閲覧」側。副作用なしの SELECT のみ。

引数（Zod）:

| 引数 | 型 | 説明 |
|---|---|---|
| `state` | `enum`（任意） | `pending` / `applied` / `rejected` で絞り込み |
| `kind` | `enum`（任意） | `task` / `decision` / `reply_draft` / `triage` / `commitment` で絞り込み |
| `updatedAfter` / `updatedBefore` | ISO 8601（任意） | `updated_at` 時間窓（下限 inclusive / 上限 exclusive） |
| `limit` | `number`（任意） | 最大行数（既定 50） |

戻り値: `{ "proposals": [{ "candidateId": "cand_...", "mode": "...", "kind": "...", "entityId": "...", "summary": "...", "state": "pending", "reason": "", "createdAt": "...", "updatedAt": "..." }] }`。各行は `reason` を持ち、`state = rejected` の候補では却下理由（`propose.reject` / `propose.batch` で記録された値）、`state = pending` の候補では `proposal.feedback` が記録した再生成ヒントが入る（どちらも無ければ空文字列）。`state = rejected` で絞れば却下済み候補と理由の一覧になる（#197）。

### `propose.reject`（確定・write / HITL・idempotent）

`pending` の候補を理由付きで却下する write tool（実体は `src/propose/reject.ts`）。`ProposalRejected` event を append し、ledger を `pending` → `rejected` に遷移させる。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）: `{ "candidateId": string, "reason"?: string }`（`candidateId` は `propose.generate` 戻り値の id）。

**状態依存の挙動**: `pending` のときのみ却下（event append）。`applied`（既に適用済み）/ `missing`（該当 ledger 行なし）は遷移させず status で報告し、`rejected` 再呼び出しは `already_rejected`（no-op、idempotent）。却下済み候補は `propose.list` で `pending` として現れなくなるため、ホストは再び承認候補として提示しない。

**summary redaction（[ADR-0026](../adr/0026-source-forgetting.md) R1-3）**: `rejected` 遷移時に当該候補の `ProposalGenerated.summary` を `json_set` で空白化する（マーカー `[redacted]`。event payload + `proposals.summary` 列の両方）。reply_draft 候補の summary は**下書き全文**なので、人が却下した本文を ledger / event に残さない（発生源対策）。`source.forget` とは独立に適用する。同一 reject transaction 内で原子的に実行（実体は `src/forget/cascade.ts` の `redactProposalSummary`）。

戻り値: `{ "candidateId": "cand_...", "status": "rejected" | "already_rejected" | "applied" | "missing" }`。

### `proposal.feedback`（確定・write / HITL・#279）

`pending` の候補に「修正して再生成」用の reason を記録する write tool（実体は `src/propose/feedback.ts`）。`ProposalFeedback` event を append し、ledger 行の `reason` を更新するが **state は遷移させない**（`pending` のまま・apply/reject 可能なまま）。apply / reject の二択に対する第 3 の選択肢で、却下せずに「次はこう直して」を残せる（ホストは記録した reason を `propose.list` で読み、次の `propose.generate` の手がかりにする）。HITL（`readOnlyHint: false`、auto-apply なし、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

引数（Zod）: `{ "candidateId": string, "reason": string（min 1） }`（`candidateId` は `propose.generate` 戻り値の id）。`reason` は必須（空のフィードバックは意味を持たないため）。

**状態依存の挙動**: `pending` のときのみ reason 記録（event append）。`applied` / `rejected`（既に決定済み）/ `missing`（該当 ledger 行なし）は変更せず status で報告する。同一候補への再記録は最新の reason で上書きする（latest wins）。

戻り値: `{ "candidateId": "cand_...", "status": "recorded" | "applied" | "rejected" | "missing" }`。

### `propose.batch`（確定・write / HITL・atomic・#197）

承認/却下 HITL ループの `propose.apply` + `propose.reject` を **1 RPC・単一トランザクション**に畳む write tool（実体は `src/propose/batch.ts`）。ホストが「これを適用・あれを却下」と一括決定したとき、2 RPC に分けると chatty かつ非アトミック（途中失敗で ledger が半端に決定される）なので、操作リストを 1 つの `sqlite.transaction()` で commit して all-or-nothing にする。

引数（Zod）: `{ "operations": Operation[] }`。`Operation` は `action` の discriminated union:

- `{ "action": "apply", "candidate": Candidate }` — 承認済みの id 付き候補を適用。apply は domain event を組むため候補ペイロード全体が必要（ledger は summary / entity_id しか持たないので candidateId だけでは不足。`propose.generate` の戻り値の候補をホストが再投入する＝`propose.apply` と同じ契約）。
- `{ "action": "reject", "candidateId": string, "reason"?: string }` — pending 候補を candidateId で却下。

op ごとのロジック・semantics は `propose.apply` / `propose.reject` をそのまま再利用する（apply は candidateId の round-trip 冪等・#435 — 適用済み ledger 行 / 同一バッチ内の重複 candidateId は `skipped`、reject は pending のときのみ却下し `applied` / `missing` / `already_rejected` は報告のみ）。差分は**トランザクション境界だけ**: バッチ全体を 1 transaction で包むため、いずれかの op が throw（不正な候補等）すると **バッチ全体が rollback** する（部分書き込みなし、[ADR-0002](../adr/0002-event-sourced-architecture.md)）。HITL（`readOnlyHint: false`、auto-apply なし、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

戻り値:

```jsonc
{
  "results": [
    { "action": "apply",  "candidateId": "cand_...", "kind": "task", "entityId": "task_...", "status": "applied" },
    { "action": "reject", "candidateId": "cand_...", "status": "rejected" }
  ],
  "applied": 1,   // apply op で append された候補数
  "skipped": 0,   // apply op で適用済み（round-trip 冪等）により no-op だった候補数
  "rejected": 1   // reject op で pending → rejected に遷移した候補数
}
```

### `task.create`（確定・write / HITL・#12 追補 D2）

人が直接 task を追加する write tool（`propose.*` がモデル提案なのに対し、人自身の「これを task に」経路。`next-actions` skill 等が使う）。実体は `src/propose/task-create.ts`。`TaskProposed` event を append → `tasks` projection。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）:

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `title` | `string`（min 1） | — | task タイトル |
| `dueDate` | `string`（ISO 8601・任意） | null | 期日（[ADR-0028](../adr/0028-task-scheduling-fields.md)） |
| `priority` | `enum`（`low` / `normal` / `high`・任意） | null | 優先度（[ADR-0028](../adr/0028-task-scheduling-fields.md)） |
| `sourceExternalIds` | `string[]`（任意） | `[]` | provenance（→ `links`） |

戻り値: `{ "taskId": "task_...", "status": "created" | "existing", "duplicate"?: { "taskId", "state", "updatedAt" } }`。`taskId` は title + provenance 由来（`dueDate` / `priority` は id に含めない＝期日変更で別 task に分裂しない、[ADR-0028](../adr/0028-task-scheduling-fields.md)）。同一内容の重複判定は task の lifecycle 状態を見る（#435）:

- **live な重複あり**（`proposed` / `open` / `in_progress`）→ `existing`（no-op）。`duplicate` に重複行の id / state / updatedAt を返すので、ホストは「reopen する / 既存を示す」vs「本当に新規」を明示的に人へ提示できる（silent nothing にしない）
- **terminal な一致のみ**（`completed` / `dropped`）→ **新規作成をブロックしない**。`-N` suffix 付きの id を採番して `created`（繰り返しタイトル「経費精算」等が store の寿命で 1 回しか作れない問題の解消・[boundary/propose-1]）

### `task.update`（確定・write / HITL）

task の lifecycle 状態を遷移させる write tool（`task.create` が task を開き `task.list` が読むのに対し、状態を前進させる経路。`task-update` skill が使う）。実体は `src/propose/task-update.ts`。`TaskApplied` event を append → `tasks` projection（reducer が既存 task の `state` を UPDATE。event/reducer は既存で、本 tool は欠けていた write surface を補う）。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）:

| 引数 | 型 | 説明 |
|---|---|---|
| `taskId` | `string`（min 1） | 遷移対象の task id |
| `state` | `enum` | 遷移先 `open` / `in_progress` / `completed` / `dropped` |
| `dueDate` | `string`（ISO 8601・任意） | 同時に期日を (re)set（null は既存値維持、[ADR-0028](../adr/0028-task-scheduling-fields.md)） |
| `priority` | `enum`（`low` / `normal` / `high`・任意） | 同時に優先度を (re)set（null は既存値維持、[ADR-0028](../adr/0028-task-scheduling-fields.md)） |

戻り値: `{ "taskId": "task_...", "status": "updated" \| "unchanged" \| "missing", "state": "completed" \| null }`。

- **idempotent**: 現在 state と同一かつ scheduling 更新なし（`dueDate` / `priority` ともに null）は `unchanged`（event を append しない）。`missing`（該当 task なし）は status で報告し throw しない（commitment 遷移群と同じ作法）
- **scheduling 更新**: 同一 state でも非 null の `dueDate` / `priority` を渡せば (re)set として `updated`（[ADR-0028](../adr/0028-task-scheduling-fields.md)）。reducer は null を COALESCE で既存値維持する
- **禁止遷移なし**: 4 状態は相互に到達可能（`completed` の task を `in_progress` に戻す等も許可）。task lifecycle に invalid 遷移は設けない
- 新規 task の作成は `task.create`（本 tool は遷移専用で title を持たない）
- **公開済みタスクの state 変更は actuator へ統一（ADR-0036 §3）**: `published_external_id` を持つタスクの state 遷移は、ローカルを先に変えず **actuator に操作命令を発行**（completed→complete / open・in_progress→reopen、dropped は best-effort）。外部成功後に optimistic な `TaskApplied` をキャッシュし read-back が整合させる。このため `task.update` は `openWorldHint: true`、egress 失敗時は構造化エラー（`EGRESS_FAILED` 等）。**R1-3（ADR-0036）**: actuator 設定はその task **自身の `published_destination`** に対応する `[tasks.homes.<destination>]` で解決する（現在の `[tasks].default` ではない）＝既定を乗り換えても既存 published task の遷移は壊れない。未公開タスク（private tier・R1-4）は従来どおりローカルのみ・throw しない

### `task.publish` / `task.act`（確定・write / HITL・egress・[ADR-0036](../adr/0036-task-external-home.md)）

確定 task を**外部ホーム**（`[tasks.homes.<destination>]`：GitHub Issues / Jira / Slack List。destination ごとに独立設定）へ起票し、以後の状態操作を外部へ書き戻す egress write tool 群。新規 publish の既定行き先は `[tasks].default`（ADR-0036 §改訂 R1）。状態正本はツール側＝suasor は読む + 操作命令を出す single pane。read 専用 connector 契約（[ADR-0007](../adr/0007-connector-contract.md)）は不変で、write は別 capability `Actuator`（`src/connectors/actuator.ts`）。両 tool とも HITL（`readOnlyHint: false`）・`openWorldHint: true`（外部 I/O）。失敗は構造化エラー（[ADR-0031](../adr/0031-mcp-structured-errors.md)）`ACTUATOR_NOT_CONFIGURED` / `PUBLISH_DESTINATION_INVALID` / `EGRESS_FAILED`。

- **`task.publish`**（`src/propose/task-publish.ts`）— 引数 `{ taskId, destination? }`。`destination` は `github \| jira \| slack`（**R1-2**・省略時 `[tasks].default`）で `[tasks.homes.<destination>]` を解決。actuator が起票（`taskId` を冪等キーに marker 検索→既存再利用）→ 成功時のみ `TaskPublished` を append（外部 write → event の順序）。戻り値 `{ taskId, destination, externalId, status: "published" \| "existing" }`。公開済み task は `existing`（自身の記録済み destination）で二重起票しない。既定も対象ホームも未設定なら `ACTUATOR_NOT_CONFIGURED`。
- **`task.act`**（同上）— 引数 `{ taskId, action: "complete" \| "reopen" \| "comment", body? }`。公開済み task の外部項目へ操作を発行 → `TaskActionIssued`（body-less）を append。**R1-3（重要）**: actuator 設定は task 自身の `published_destination` に対応する `[tasks.homes.<destination>]` で解決する（現在の `default` ではない）＝既定を乗り換えても既存 published task の操作は壊れない。未公開 task は `INVALID_STATE`。`comment` は `body` 必須。
- **読み戻し（D4）**: 完了状態 + 期日 / 優先度はツール側で変わり、既存 sync 経由で `TaskApplied` に反映（read→ローカル event のみ＝ループしない）。
- **ループ回避**: 起票項目に label `suasor` + body marker `<!-- suasor:task:<id> -->` を刻み、`published_to` link で native task と外部 mirror を 1 行に畳む（[ADR-0036](../adr/0036-task-external-home.md) §8）。

### `decision.record`（確定・write / HITL・[Issue #88](https://github.com/ozzy-labs/suasor/issues/88)）

人が直接 decision を記録する write tool（`task.create` の decision 版）。実体は `src/propose/decision-record.ts`。`DecisionRecorded` event を append → `decisions` projection。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）:

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `title` | `string`（min 1） | — | decision タイトル |
| `rationale` | `string`（任意） | `""` | 決定理由 |
| `sourceExternalIds` | `string[]`（任意） | `[]` | provenance（→ `links`） |

戻り値: `{ "decisionId": "dec_...", "status": "created" | "existing" }`。`decisionId` は title + **rationale** + provenance 由来（`propose.apply` の `decision` 候補と同一 fingerprint・#435）で、同一内容の再記録は `existing`（no-op、idempotent）。rationale が異なれば **別 decision として記録**される（従来は rationale を id に含めず「先勝ち」で後の rationale が黙って失われた）。

### `inbox.add`（確定・write / HITL・[Issue #88](https://github.com/ozzy-labs/suasor/issues/88)）

受信箱項目を捕捉する write tool（日次 triage ループの捕捉側）。実体は `src/propose/inbox-add.ts`。`InboxItemTriaged`（state `open`）を append → `inbox` projection（`InboxItemTriaged` が唯一の inbox lifecycle event で、捕捉は `open` への遷移）。HITL。

引数（Zod）: `{ "sourceExternalId": string（min 1） }`（捕捉する source。provenance → `links` の `references`）。

戻り値: `{ "inboxId": "inbox_...", "status": "created" | "existing" }`。`inboxId` は source 由来で、同一 source の再捕捉は `existing`（no-op、idempotent）。

### `inbox.triage`（確定・write / HITL・state machine・[Issue #88](https://github.com/ozzy-labs/suasor/issues/88)）

`open` の受信箱項目を inbox から出す write tool（triage ループの解決側）。実体は `src/propose/inbox-triage.ts`。`inbox` projection 上の小さな state machine で、項目は `open` のときのみ triage 可能。

| `action` | 効果 | inbox 遷移 | 生成 entity |
|---|---|---|---|
| `task` | `TaskProposed`（項目の source 由来 task）を append | → `done` | task（`title` 必須） |
| `decision` | `DecisionRecorded`（source 由来 decision）を append | → `done` | decision（`title` 必須、`rationale` 任意） |
| `discard` | （entity なし） | → `dismissed` | — |

引数（Zod）:

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `inboxId` | `string`（min 1） | — | triage 対象の inbox 項目 id |
| `action` | `enum`（`task` / `decision` / `discard`） | — | 遷移先 |
| `title` | `string`（任意） | — | 生成する task/decision の title（`task` / `decision` で必須） |
| `rationale` | `string`（任意） | — | 生成する decision の rationale（`decision` のみ） |

生成される task/decision の id は `task.create` / `decision.record` と同一の content 由来 identity（`src/propose/id.ts` / `identity.ts`）で、同一内容なら同じ projection 行に着地する。task は `task.create` と同じ重複判定に従う（#435）: live な同一内容 task があればその行を再利用し、terminal（`completed` / `dropped`）の一致のみなら `-N` suffix 付きの新規 task を採番する（再来する source の再 triage が完了済み行を黙って上書きしない）。

戻り値: `{ "inboxId": "inbox_...", "action": "...", "state": "done" | "dismissed", "createdEntityId"?: "task_..." | "dec_..." }`。

**不正遷移は拒否（tool error）**: 存在しない項目、または既に `open` 以外（`snoozed` / `done` / `dismissed`）の項目を triage しようとすると tool error を返す（host が拒否を表示できるよう silent skip しない）。これにより二重解決や解決済み項目の再オープンを防ぐ。

### `link.add`（確定・write / HITL・[Issue #90](https://github.com/ozzy-labs/suasor/issues/90)）

2 エンティティ間に**手動** provenance link を作成する write tool（[ADR-0018](../adr/0018-knowledge-graph-traversal.md) 追補）。reducer 由来の自動エッジ（`derived_from` / `replies_to` / `references`）と異なり、人/エージェントが明示的に「この 2 つを関連付ける」経路。実体は `src/propose/link-add.ts`。`LinkAdded` event を append → `links` projection に relation `manual_link` で反映（`graph.related` / `graph.expand` が辿れる）。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）:

| 引数 | 型 | 説明 |
|---|---|---|
| `fromKind` | `string`（min 1） | 起点エンティティ kind（例 `task` / `decision` / `source`） |
| `fromId` | `string`（min 1） | 起点エンティティ id |
| `toKind` | `string`（min 1） | 終点エンティティ kind |
| `toId` | `string`（min 1） | 終点エンティティ id |

戻り値: `{ "linkId": "link_...", "status": "created" | "existing" }`。`linkId` は有向な端点ペア（`fromKind/fromId` → `toKind/toId`）由来で、同一 link の再追加は `existing`（no-op、idempotent）。向きは区別する（A→B と B→A は別 link）。**自己ループ（両端が同一 kind + id）は tool error で拒否**する（provenance 上意味を持たないため）。

### `link.remove`（確定・write / HITL・[Issue #90](https://github.com/ozzy-labs/suasor/issues/90)）

手動 link を id 指定で削除する write tool（`link.add` の対）。実体は `src/propose/link-remove.ts`。`LinkRemoved` event を append → `links` projection から該当行が消える（`graph.*` から辿れなくなる）。event log は add/remove ペアを保持するため、link のライフサイクルは監査可能。HITL。

**手動 link のみ削除可能**: reducer 由来の provenance エッジ（`derived_from` / `replies_to` / `references`）は `link_id` を持たず reducer 所有のため削除対象外。削除対象の `linkId` は `graph.related` の neighbor に付与される `linkId` フィールドから取得する。

引数（Zod）: `{ "linkId": string（min 1） }`（`link.add` が返した `linkId`）。

戻り値: `{ "linkId": "link_...", "status": "removed" }`。**存在しない link の remove は tool error で拒否**する（host が誤りを表示できるよう silent no-op しない）。

### commitment 台帳（確定・[ADR-0021](../adr/0021-commitment-ledger.md)・[Issue #91](https://github.com/ozzy-labs/suasor/issues/91)）

取り込み済み source から LLM で抽出した「約束/コミットメント」（"X までに Y する" の類）を `open` / `resolved` / `dismissed` で HITL 管理する台帳。**抽出は専用 LLM 経路を新設せず propose パイプラインに寄せる**（[ADR-0006](../adr/0006-ml-delegation.md) ML 委譲境界を 1 本に保つ）: `propose.generate` の `commitment_scan` mode が `commitment` 候補を出し、`propose.apply` が `CommitmentOpened` を append して台帳に `open` で登録する。read は `commitment.list`、状態遷移は専用 write tool 群。

```text
commitment_scan (propose.generate → propose.apply)
        │ CommitmentOpened
        ▼
     ┌──────┐  commitment.set   ┌──────────┐
     │ open │ ────────────────────▶ │ resolved │
     └──────┘                       └──────────┘
        │ commitment.set     ▲        │
        ▼                        │        │ commitment.set
   ┌───────────┐  commitment.set       │
   │ dismissed │ ◀────────────────────────┘
   └───────────┘
```

- **`commitment.list`（read）**: **既定で緊急度順**（期限超過が先頭・超過が長い順 → 期日が近い順 → 期日なし・更新新しい順）。各行に read 時派生の `overdue`（`now` 注入可能・projection には焼かない）。`dueBefore` / `overdue` フィルタも持つ（[#509](https://github.com/ozzy-labs/suasor/issues/509)）。**旧実装は `updated_at DESC` 固定で、最も催促が必要な「長期放置かつ期限超過」の約束が最後に並び、行数打切りで最初に消えていた** — `commitment-chase` の存在意義を潰す並びだった。`open` / `resolved` / `dismissed` の state、`owed_by_me` / `owed_to_me` の direction、`person` でフィルタ。`updated_at` の時間フィルタ可。**`person` フィルタは person identity graph（[ADR-0022](../adr/0022-person-identity-resolution.md)）越しに一致する**（[#443](https://github.com/ozzy-labs/suasor/issues/443)）: person id / identity key（`slack:U123`）/ 素の handle / display name のどれで引いても、同一人物の別名で記録された約束がすべて出る。解決できない文字列は従来どおり生文字列の完全一致にフォールバックする。戻り値は `person`（記録どおりの生文字列・表示用）に加えて `personId` / `personName`（正規化された人物）を持つ。`brief` / `next-actions` / `commitment-chase` skill が demand と並べて「やるべきこと」signal として取り込める。
- **`commitment.set`（`state="resolved"`）（write / HITL）**: `open` → `resolved`（`CommitmentResolved` append）。idempotent（既 `resolved` は no-op）。`dismissed` からは `invalid_state`（先に reopen）、該当なしは `missing`。
- **`commitment.set`（`state="dismissed"`）（write / HITL）**: `open` → `dismissed`（誤検出/不要、`CommitmentDismissed` append）。idempotent。`resolved` からは `invalid_state`、該当なしは `missing`。
- **`commitment.set`（`state="open"`）（write / HITL）**: `resolved` / `dismissed` → `open`（`CommitmentReopened` append）。既 `open` は no-op、該当なしは `missing`。

commitment id は content 由来（`title` + `direction` + provenance）なので、同一 commitment の再抽出は台帳上 no-op（idempotent）で `resolved` / `dismissed` を `open` に蘇生させない。`dueDate` / `person` は可変 context として id に含めない。

`person_id` は fold 時に解決して projection に保存する（生文字列は表示用に保持）。**曖昧なら解決しない** — 同名 2 人のどちらかを黙って選ぶより、未リンクのまま残す方が安全（誤リンクは他人の約束を自分の台帳に混ぜる）。`PersonsMerged` は台帳も cascade し（統合したのに約束が空になった person 側に残るのは、merge が解消しようとした分裂そのもの）、`PersonSplit` は**その handle 経由でリンクされた行だけ**を戻す。identity が commitment より後に観測された場合は `person_id` が NULL のまま残るが、`person` フィルタの生文字列分岐で引ける。

**`commitment_scan_stale`**（[#443](https://github.com/ozzy-labs/suasor/issues/443)）: 台帳は完全に pull（誰かが `commitment_scan` を思いつくまで約束は入らない）で、取りこぼしはエラーではなく**不在**として現れるため気づけない。最新の commitment 提案時刻と最新の source 観測時刻を比べ、未スキャンの source 件数を brief / digest の completeness warning として出す（MAX 2 回 + COUNT の決定論。推論はしない）。

### `demand.mark`（`state`）（確定・write / HITL・[ADR-0041](../adr/0041-neutral-demand-priority-substrate.md)）

demand の seen-state 側の write tool 群。`demand.list` は取り込み済み source から未処理 demand（@mention / DM / notification）を導出するが、demand は**導出 view であって stored entity ではない**ため、seen 状態は source `externalId` をキーにした専用 `demand_seen` projection に持つ。実体は `src/propose/demand.ts`。ADR-0012 決定 4 の host 委譲 seen-marker を supersede（状態の置き場は host の記憶ではなく event ログ、[ADR-0002](../adr/0002-event-sourced-architecture.md)）。

- **`demand.mark`（`state="acked"`）（write / HITL）**: demand 行を「対応済み」に印（`DemandAcknowledged` append → `demand_seen` state `acked`）。以後 既定の `demand.list` から外れ、`next-actions` / `priority.list` の demand tier にも出なくなる。idempotent（既 `acked` は no-op `already_acked`）。`dismissed` 行は `acked` に上書き（LWW）。該当 source なしは `missing`。
- **`demand.mark`（`state="dismissed"`）（write / HITL）**: demand 行を「対応不要」に印（`DemandDismissed` append → `demand_seen` state `dismissed`）。idempotent（既 `dismissed` は `already_dismissed`）。`acked` 行は `dismissed` に上書き。該当なしは `missing`。

引数（Zod）: `{ "externalId": string }`（min 1・demand 行の source id）。`demand_seen` は last-write-wins なので replay 安定。

### `person.merge`（確定・write / HITL・[Issue #92](https://github.com/ozzy-labs/suasor/issues/92)）

2 person を 1 つに統合する write tool（[ADR-0022](../adr/0022-person-identity-resolution.md)）。operator が明示的に「この 2 つは同一人物」と判断する経路で、**自動 fuzzy 同定はしない**（ADR-0022 で却下）。実体は `src/propose/person-merge.ts`。`PersonsMerged` event を append → source person の identity を target に付け替え（source は `identity_count = 0` で空に）。HITL（`readOnlyHint: false`、auto-apply なし）。event log で監査可能・`person.split` で可逆。

引数（Zod）: `{ "targetPersonId": string, "sourcePersonId": string }`（いずれも min 1）。

戻り値: `{ "targetPersonId", "sourcePersonId", "movedIdentities": number, "status": "merged"|"noop" }`。**self-merge（同一 id）/ 未知の source person は tool error**。source が既に空（再 merge）は `noop`（idempotent）。

### `person.split`（確定・write / HITL・[Issue #92](https://github.com/ozzy-labs/suasor/issues/92)）

1 つの `(connector, handle)` identity を現在の person から別 person に分離する write tool（`person.merge` の逆操作、過剰 merge の訂正）。実体は `src/propose/person-split.ts`。`PersonSplit` event を append → identity の `person_id` を付け替え。`newPersonId` 省略時は identity 本来の content 由来 person（`personIdFor(connector, handle)`、= merge を巻き戻す既定の戻り先）に送る。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）: `{ "connector": string, "handle": string, "newPersonId"?: string }`（`connector` / `handle` は min 1）。

戻り値: `{ "connector", "handle", "newPersonId", "status": "split"|"noop" }`。**未知の identity は tool error**。既に target person に解決済みなら `noop`。

### `draft.export`（確定・write / HITL・[ADR-0025](../adr/0025-local-draft-export.md)）

下書き（返信 / 引き継ぎ / 告知 / 計画 等のテキスト）を**ローカルファイルに書き出す** write tool。実体は `src/export/draft-export.ts`。**既定で送信しない・source に書き戻さない**（local-first / no-egress）。唯一の例外は Office 形式（docx/pptx/xlsx）を **remote な `[export].composition` サイドカー**（`composition.allowRemote` で opt-in・非 loopback）で合成する場合で、そのとき本文がサイドカーへ egress し、戻り値の `composedViaRemoteSidecar: true` で開示される（Issue #436）。`[export].dir` の sandbox 配下のみに書き、書き込み後に **body-less `DraftExported`** event を append（content-minimization・監査）。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）:

| 引数 | 型 | 説明 |
|---|---|---|
| `content` | `string` | 書き出す下書き本文 |
| `filename` | `string`（min 1） | ファイル名（**basename のみ**。`/` `\` `..` 絶対パスは拒否） |
| `format` | `enum`（`md` / `txt` / `docx` / `pptx` / `xlsx`） | 出力形式（拡張子が無ければ付与）。`docx`/`pptx`/`xlsx` は `[export].composition` 有効時のみ（#138）。無効で要求すると tool error |
| `sourceExternalId` | `string`（任意） | provenance |

戻り値: `{ "path": "<書き出した絶対パス>", "status": "exported" }`。remote な composition サイドカーで合成した場合のみ `"composedViaRemoteSidecar": true` を併記（egress 開示・Issue #436。loopback / md / txt では省略＝egress なし）。

- **sandbox**: `[export].dir` 配下のみ。`filename` basename 限定・traversal 拒否。`[export].dir` が無ければ作成
- **`local.roots` 重複拒否**: `[export].dir` が `[connectors.local].roots` 配下/一致だと再取り込みループになるため tool error（[ADR-0023](../adr/0023-local-filesystem-connectors.md)）
- **衝突**: 既存ファイルがあれば連番付与（`name.md` → `name-1.md`）で非破壊
- **順序**: ファイル書き込み → 成功時のみ `DraftExported` を append（write 失敗時は event を残さない）。replay は reducer no-op でファイルを再生成しない
- Office 形式（docx/pptx/xlsx）は `[export].composition` サイドカー（md→Office、抽出 [ADR-0024](../adr/0024-document-extraction-sidecar.md) の逆方向・#138）で変換してから書き出す。無効時は md/txt のみ（Office 要求は tool error）。docx を第一級、pptx/xlsx はサイドカー対応次第のベストエフォート
- **remote サイドカー egress ゲート（Issue #436・[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）**: `composition.baseUrl` は loopback allowlist（`localhost` / `127.0.0.0/8` / `::1`）でゲートされ、非 loopback は `composition.allowRemote = true` を明示しない限り config load で `ConfigError`（fail-fast）。opt-in 済み remote サイドカーで Office 合成したときは本文が egress するため、戻り値に `composedViaRemoteSidecar: true` を返し、起動 / doctor / validate-config も config WARN で開示する

### `source.forget`（確定・write / HITL・[ADR-0026](../adr/0026-source-forgetting.md)）

取り込み source を**ローカルから消す** write tool（「忘れられる権利」/ 誤取り込み / 機密）。実体は `src/forget/source-forget.ts`。content-minimization（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）のため **projection だけでなく event ログ本文も消す**:

- **redaction**: 当該 `externalId` の `SourceObserved`/`SourceBodyUpdated` の `body` を `json_set(payload,'$.body','')` で空白化（append-only の明示的例外・[ADR-0026](../adr/0026-source-forgetting.md)）
- **`SourceForgotten` event**（body なし監査）を append → **reducer が `sources`/`sources_fts` を DELETE + `forgotten_sources` tombstone を INSERT**（replay-stable: rebuild=truncate+replay でも redact 済み SourceObserved の空行を再 DELETE して absent に収束し、tombstone も再現）
- **tombstone（R1-1）**: `forgotten_sources` projection に externalId を記録し、`runSyncPass`（[ADR-0007](../adr/0007-connector-contract.md)）が fingerprint 判定より前に該当 externalId の**再観測をスキップ**する。これが無いと上流に残る source は次回 sync で全文復活する。解除は `source.unforget` のみ
- **sidecar substrate**（`vec0`/`embeddings_meta`/`extraction_meta`）は tool が imperative に DELETE（replay 管理外）
- **原子性（R1-4）**: redaction + sidecar 削除 + `SourceForgotten` append を**単一 sqlite transaction** で包む（`store.record` は SAVEPOINT で入れ子）。mid-forget クラッシュで中間状態が残らない
- **物理消去（R1-5）**: 削除前後で `secure_delete` を有効化（free page をゼロ埋め）し、commit 後に `PRAGMA wal_checkpoint(TRUNCATE)` で WAL を畳み込む。redact 済み平文が free page / WAL に残らない。Suasor の外に出た copy（draft export 済み・`VACUUM INTO` backup・OS backup・host 会話履歴）は射程外
- **派生 content 開示（R1-2・必須）**: forget 時に links provenance（`derived_from` / `replies_to` / `references`、`idx_links_to`）+ proposals ledger（`ProposalGenerated.sourceExternalIds`。**reject 済み候補も含む**）+ `DraftExported` パスを辿り、派生 entity を **`derived` で必ず開示**する（`cascade` 指定の有無に関わらず。実体は `src/forget/cascade.ts`）
- **cascade redaction（R1-2・HITL opt-in）**: `cascade: true` のとき、派生 event の自由文 field（`TaskProposed.title` / `DecisionRecorded.title`・`rationale` / `ReplyDraftProposed.body` / `CommitmentOpened.title` / `ProposalGenerated.summary`）を body redaction と同じ `json_set` 方式で空白化し、対応する projection 列も更新する（同一 forget transaction・secure_delete 経路に乗る・replay-stable）。空白化は `title` の `min(1)` を満たすマーカー（`[redacted]`）で行う（redact 済み event が replay 時の Zod 再検証を通るため）。`draft_export` パス・backup 等は開示のみで redact しない（射程外）
- links は残す（provenance・`source.get` は null）

引数（Zod）: `externalId: string`（min 1）/ `reason?: string`（監査用）/ `cascade?: boolean`（既定 `false`。派生 content の redaction）。

戻り値: `{ "externalId": "...", "status": "forgotten" | "already_forgotten" | "missing", "tombstoned": boolean, "derived": DerivedEntity[], "cascaded": boolean, "note"?: string }`。`tombstoned` は tombstone が張られたか（`forgotten`/`already_forgotten` で `true`、`missing` で `false`）。`derived` は派生 entity 一覧（`{ kind, id, relation, redactable }`。`missing` では空）で **常に返る**（開示必須）。`cascaded` は派生 redaction が走ったか。`note` は enabled な connector がある場合のみ付き、tombstone が再取り込みを防いでいる旨を通知する。idempotent（再 forget は `already_forgotten`。ただし `cascade: true` なら purged 済み source でも派生 redaction は走る）。HITL（`readOnlyHint: false`、auto-apply なし）。

### `source.unforget`（確定・write / HITL・[ADR-0026](../adr/0026-source-forgetting.md) R1-1）

forget tombstone を**解除**し、owning connector が次回 sync で当該 source を**再取り込みできる**ようにする write tool。実体は `src/forget/source-forget.ts` の `sourceUnforget`。body なしの `SourceUnforgotten` event を append し、その reducer が `forgotten_sources` 行を DELETE する。**redaction 済みの本文は復元しない**（source が上流に残っていれば再観測で戻る）。

引数（Zod）: `externalId: string`（min 1）。

戻り値: `{ "externalId": "...", "status": "unforgotten" | "not_forgotten" }`。idempotent（未 forget の id は `not_forgotten` の no-op）。HITL（`readOnlyHint: false`、auto-apply なし）。

## Tool introspection（`suasor mcp tools`）

`suasor mcp tools [--json]` は上記 tool surface を **server を起動せず**列挙する（name / read·write 区分 = `readOnlyHint` / 1 行概要）。ドキュメント生成や surface のスモークチェック用途で、Store も開かず副作用もない（[cli](cli.md)）。

カタログのデータ SSOT は `src/mcp/tool-catalog.ts`（read tool 群 + writable store 供給時のみ登録される write/HITL tool 群）。入力 schema・ハンドラの正本は引き続き `src/mcp/server-read.ts` / `src/mcp/server-write.ts` の Zod 登録コード（`server.ts` は両者を束ねる factory のみ）。両者の drift は `tests/mcp/tool-catalog.test.ts` が実際に登録される server の tool（name / `readOnlyHint`）と突き合わせて防ぐ（full / read-only deployment の両 surface を検証）。

## 構造化エラー + 起動時 readiness（[ADR-0031](../adr/0031-mcp-structured-errors.md)）

tool 実行の失敗は MCP 規約どおり **正常に `isError: true` を返す**（プロトコルレベル error ではない）。失敗結果は成功の `jsonResult` と対称に、**`{ code, message, hint }` の JSON を 1 つの text content** に詰める（`src/mcp/errors.ts` の `toolError` / `toToolError`）。host は `JSON.parse` して `code` で分岐し、`hint`（直し方）をユーザーに提示できる。`message` は素の text しか見ない host 向けに human-readable に残す。

`code` 体系（安定文字列・改名は破壊的変更）:

| code | 意味 | 例 |
|---|---|---|
| `INVALID_INPUT` | Zod schema を超えた入力不正 | self-loop link / self-merge / 不正 filename |
| `INVALID_STATE` | エンティティは在るが遷移不可 | `open` でない inbox item の triage |
| `REJECTED_CANDIDATE` | 人が却下済みの候補を apply/batch しようとした（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)） | ledger 行 `rejected` の candidateId を `propose.apply` |
| `CONFIRMATION_DECLINED` | 不可逆/egress tool の `elicitInput` 確認が却下された（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)） | `source.forget` の確認往復を人が decline |
| `MISSING_ENTITY` | 参照先が存在しない | 未知の link id / inbox item / person identity |
| `EXPORT_DIR_NOT_CONFIGURED` | `draft.export` で `[export].dir` 未設定 | — |
| `CONFIG_INVALID` | critical config 欠落/不正（boot or call） | `storage.dbPath` 未設定 |
| `UNKNOWN_CONNECTOR` | `connector.sync` で未登録 connector | — |
| `INTERNAL` | 想定外失敗（fallback。クラッシュを構造化 error に degrade） | — |

read tool は副作用なし＝throw しないため code を持たない。

**起動時 readiness**: `serveMcp` は起動時に `verifyReadiness(config)` で critical config を検証し、欠落（`storage.dbPath` 未設定 → `CONFIG_INVALID`）は code + hint を stderr に出して fail-fast する（store を開く前）。`[export].dir` は致命にせず、`draft.export` 呼び出し時の `EXPORT_DIR_NOT_CONFIGURED` に degrade する（任意機能のため・[ADR-0025](../adr/0025-local-draft-export.md)）。

## 規約

- read = `readOnlyHint: true`（副作用なし）。write = HITL（auto-apply 経路を持たない）
- 外部送信を伴うものは write 扱い（per call HITL）。**ローカルファイル書き込み（`draft.export`）も write/HITL**（egress は無いが副作用があるため・[ADR-0025](../adr/0025-local-draft-export.md)）
- **event ログの redaction（`source.forget`）は append-only の明示的例外**（[ADR-0026](../adr/0026-source-forgetting.md)）。「忘れられる権利」のため forget 対象 source の `body` のみを上書きし、`SourceForgotten` 監査 event で痕跡を残す
- stdio transport では stdout に JSON-RPC フレーム以外を書かない（診断は stderr）
- 詳細スキーマ（引数・戻り値）は実装（`src/mcp/server-read.ts` / `src/mcp/server-write.ts`）の Zod を正本とする

[#11]: https://github.com/ozzy-labs/suasor/issues/11
