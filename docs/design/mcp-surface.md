# MCP Surface

[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)。MCP TS SDK（`@modelcontextprotocol/sdk`、stdio transport）で公開。tool 入力は Zod schema。read / write を明確に分ける。`suasor mcp serve` で起動する。

read tool 群は `src/mcp/`（`server.ts` = tool 登録 / `queries.ts` = projection SELECT / `serve.ts` = stdio 起動）で実装。すべて副作用なし（projection を SELECT するか FTS-first search service を呼ぶだけ）で、各 tool に `readOnlyHint: true` annotation を付け、host が auto-approve できるようにしている。

## Read tools（副作用なし・エージェント自律 OK）

| tool | 役割 | 状態 |
|---|---|---|
| `search` | FTS5 全文検索（`sourceType` / `observed*` フィルタ可、[retrieval](retrieval.md)） | #8 実装済（フィルタ #142） |
| `recall.search` | 意味検索（embedding 有効時の vec0 KNN。`sourceType` / `observed*` フィルタ可。無効/未到達時は空 + シグナルで FTS フォールバック） | 実装済（[#11]、フィルタ #142） |
| `search.hybrid` | FTS × 意味検索の RRF 融合（`sourceType` / `observed*` フィルタ可。embedding 無効時は FTS のみに degrade、[retrieval](retrieval.md)） | 実装済み（#142。下記参照） |
| `source.list` / `source.get` | source 一覧 / 本文取得 | #8 実装済 |
| `source.history` | source の本文版を event log から新しい順に取得（真の差分用、#121） | 実装済み（下記参照） |
| `task.list` / `decision.list` / `inbox.list` | projection 一覧（時間フィルタ可） | #8 実装済 |
| `propose.list` | 提案候補の lifecycle ledger 一覧（state: `pending` / `applied` / `rejected`、kind フィルタ可） | 実装済み（#89。下記参照） |
| `commitment.list` | commitment 台帳一覧（state: `open` / `resolved` / `dismissed`、direction: `owed_by_me` / `owed_to_me` フィルタ可、[ADR-0021](../adr/0021-commitment-ledger.md)） | 実装済み（#91。下記参照） |
| `slack.demand.list` | Slack の @mention / DM 未処理 signal（`sources` への query 導出、[ADR-0012](../adr/0012-slack-demand-digest.md)） | 実装済（#48） |
| `person.list` | 解決済み person 一覧 + 各 person の connector identity（`includeEmpty?`、[ADR-0022](../adr/0022-person-identity-resolution.md)） | 実装済み（#92。下記参照） |
| `brief` | 期間バンドル（tasks/decisions/inbox/sources/demand を期間で束ねる read tool。要約は host、[ADR-0017](../adr/0017-brief-period-bundle.md)） | 実装済み（#70） |
| `graph.related` / `graph.expand` | 既存 `links` projection 上の provenance traversal（`derived_from` / `replies_to` / `references` / `manual_link`。手動 link は `linkId` 付き、[ADR-0018](../adr/0018-knowledge-graph-traversal.md)）。`graph.expand` の `direction` で後方トレース（[ADR-0020](../adr/0020-multi-actor-coordination-scope.md)、下記参照） | 実装済み（#71・#90 / #97） |

戻り値はすべて 1 個の `text` content（JSON 文字列）。時間フィルタは各 projection の自然な timestamp 列を対象にし、**下限 inclusive (`>=`) / 上限 exclusive (`<`)**（隣接レンジの二重計上を避ける）。`iso` は ISO 8601（offset 付き）datetime。`limit` は正整数で上限 500。

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

フィルタは FTS / 短クエリ LIKE fallback の両経路に同一適用され、未指定時は従来結果と一致する（additive、#142）。

戻り値:

```jsonc
{
  "hits": [
    {
      "externalId": "gh:1",      // connector 付与 id（ADR-0007）
      "sourceType": "github_issue",
      "observedAt": "2026-06-14T00:00:00.000Z",
      "score": -1.43,             // bm25（昇順=より関連）。fallback 時は sentinel 0
      "body": "..."               // ローカル保持本文（ADR-0003）
    }
  ],
  "strategy": "fts",              // "fts" | "like-fallback"（短クエリは後者）
  "totalHits": 5,                 // limit 適用前の総マッチ数（>= hits.length）
  "truncated": false,             // limit で打ち切られたか（totalHits > hits.length）
  "analyzedQuery": ["rocket"]     // 実際に検索に使われたトークン（fallback 時は [trimmed query] 1 要素）
}
```

- `totalHits` / `truncated` は「20/20 打ち切り」と「5/5 完全」をエージェントが区別するための透明性フィールド（ADR-0007「no silent wrong answer」）
- `analyzedQuery` は FTS パスでは whitespace 分割トークン、LIKE fallback では trimmed query 1 要素。痩せ/空結果の原因（何が検索されたか）を可視化する
- ランキング・短クエリ fallback・クエリエスケープの詳細は [retrieval](retrieval.md) を参照
- 意味検索が要るケースは `recall.search`（embedding 有効時）へ

### `recall.search`（意味検索・graceful degradation・ADR-0005）

引数は `search` と同じ（`query` / `sourceType?` / `observedAfter?` / `observedBefore?` / `limit`）。embedding backend が有効なときは query を埋め込み、`vec0` の KNN で最近傍 source を引いて `search` と同形の hits を返す（`strategy` は無く、`score` は L2 distance ＝ 小さいほど近い・best-first）。`sourceType` / `observed*` フィルタは JOIN 済み `sources` 行への post-filter で適用する（KNN は多めに引いてから絞る、#142）。詳細は [retrieval](retrieval.md)。

graceful degradation（host は常に `signal === "embedding_disabled"` だけで FTS フォールバックを判断できる）:

- `[embedding].backend = "disabled"`（既定）/ 未実装 backend（openai・voyage）→ `{ "hits": [], "signal": "embedding_disabled", "reason": "backend_disabled" }`
- backend 有効だがサイドカー到達不能（Ollama down 等）→ `{ "hits": [], "signal": "embedding_disabled", "reason": "backend_unreachable" }`

`reason` は診断用の補助（host は `signal` を見る）。ingest 時の文書 embedding と query embedding は同一モデルで、`[embedding].model` が両者を駆動する（[config](config.md) / [retrieval](retrieval.md)）。

### `search.hybrid`（確定・read・RRF 融合・#142）

`search`（FTS）と `recall.search`（vec）を**両方走らせ**、2 つのランク済みリストを Reciprocal Rank Fusion（RRF）で融合する read tool。lexical（完全一致）と semantic（言語跨ぎ・語彙ミスマッチ）の盲点を相互補完する。FTS-first（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）を保ったままの additive 拡張で、新 ADR は不要（融合方式の詳細は [retrieval](retrieval.md) の Hybrid 節）。

引数（Zod）: `search` と同じ（`query` / `sourceType?` / `observedAfter?` / `observedBefore?` / `limit`）。フィルタ・limit は両経路に適用される。

戻り値:

```jsonc
{
  "hits": [
    {
      "externalId": "gh:1",
      "sourceType": "github_issue",
      "observedAt": "2026-06-14T00:00:00.000Z",
      "score": -1.43,            // 代表 hit の元 score（FTS=bm25 / vec=L2）
      "body": "...",
      "rrfScore": 0.0328         // RRF 融合スコア（降順=より関連、best-first）
    }
  ],
  "signal": "embedding_disabled" // embedding 無効/未到達で FTS のみに degrade した場合のみ
}
```

- **融合**: 各リストの 0-based rank に `1 / (k + rank)`（`k` 既定 60）を寄与とし `externalId` ごとに合算。両リストにヒットした文書は両寄与を得て上位化。重複 `externalId` は dedup（両側に居れば FTS 側 hit を代表とし lexical の `body` / `score` を保持）。同点は `externalId` 昇順で決定的
- **graceful degrade**: embedding 無効 / サイドカー到達不能のときは FTS のみで融合（実質パススルー）し、`recall.search` と同じ `embedding_disabled` シグナルを付与する（hard error にしない）

### `source.list` / `source.get`

- `source.list`: `sourceType?: string` / `observedAfter?: iso` / `observedBefore?: iso` / `limit?: int` → `{ "sources": [...] }`（`observed_at` DESC）。各 source は `externalId` / `sourceType` / `body` / `fingerprint` / `observedAt` / `meta`。
- `source.get`: `externalId: string`（min 1）→ `{ "source": {...} | null }`（本文込み、無ければ `null`）。

### `source.history`（確定・read・#121）

source の本文版を **event log から**新しい順に返す read tool（実体は `src/mcp/queries.ts` の `listSourceHistory`、`readOnlyHint: true`）。`source.get` が projection の**現本文のみ**を返すのに対し、`source.history` は append-only `events` の `SourceObserved` / `SourceBodyUpdated`（いずれも全文 `body` を保持、[ADR-0002](../adr/0002-event-sourced-architecture.md)）を `json_extract(payload,'$.externalId')` で引き、真の before/after 差分を可能にする（`doc-diff` skill が使う）。

引数（Zod）: `externalId: string`（min 1）/ `limit?: int`（新しい順・既定 50）。

戻り値: `{ "versions": [{ "observedAt", "fingerprint", "body", "recordedAt" }] }`（`recorded_at` DESC＝最新が先頭）。該当なしは `[]`。副作用なし（`events` の SELECT のみ）。

### `task.list` / `decision.list` / `inbox.list`

projection 一覧。いずれも `limit?: int`、最近更新順（対象列 DESC）。

| tool | 追加引数 | 時間窓の対象列 | 戻り値キー |
|---|---|---|---|
| `task.list` | `state?: string` / `dueBefore?: string` / `dueWithinDays?: int` / `overdue?: bool`（[ADR-0028](../adr/0028-task-scheduling-fields.md)） | `updated_at`（`updatedAfter` / `updatedBefore`） | `{ "tasks": [...] }` |
| `decision.list` | （なし） | `recorded_at`（`recordedAfter` / `recordedBefore`） | `{ "decisions": [...] }` |
| `inbox.list` | `state?: string` / `sourceType?: string` | `updated_at`（`updatedAfter` / `updatedBefore`） | `{ "items": [...] }` |

`task.list` の各 task レコードは `dueDate` / `priority`（low / normal / high・null 可）と、read 時派生の `overdue`（`dueDate < now AND state ∈ {open, in_progress}`、[ADR-0028](../adr/0028-task-scheduling-fields.md)）を持つ。`dueBefore` は `due_date < ?` で絞り（null due は除外）、`dueWithinDays: N` は「今日/今週の優先」観点で `due_date < now + N 日`（上限 exclusive、null due 除外）に絞る（`now` は overdue と同じく注入可能で決定論的）、`overdue: true` は overdue な task のみに絞る。overdue は projection に焼かず read 時に計算する（`now` は決定論テスト用に注入可能、replay 不変性を保つため・[ADR-0002](../adr/0002-event-sourced-architecture.md)）。

`inbox.list` の `sourceType` は inbox projection に `source_type` 列が無いため `sources` を JOIN して解決する（`sources.external_id = inbox.source_external_id`）。「inbox の中で slack_message だけ」のように元 source 種別で絞れる。

### `slack.demand.list`（[ADR-0012](../adr/0012-slack-demand-digest.md)）

取り込み済み `slack_message` source から **query 導出**する Slack demand（@mention / DM）。`source_type='slack_message'` かつ（DM = channel id が `D` 始まり）または（mention = `body LIKE '%<@uid>%'`）。新規 projection table は持たない。

| 追加引数 | 時間窓の対象列 | 戻り値キー |
|---|---|---|
| `selfUserId?: string`（mention 用、未指定時は config の `self_user_id` にフォールバック）/ `kinds?: ("mention"\|"dm")[]` | `observed_at`（`observedAfter` / `observedBefore`） | `{ "demand": [{ ..., "kind": "mention"\|"dm" }] }` |

`selfUserId` も config も無いと mention は無効化され DM のみ返す（`kinds: ["mention"]` 指定時は空）。

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
| `includeEmpty?: boolean`（merge で identity が 0 になった person を含めるか。既定 `false`） | `{ "persons": [{ "id", "displayName", "identityCount", "createdAt", "updatedAt", "identities": [{ "connector", "handle", "displayName", "observedAt" }] }] }` |

merge で空になった person は既定で除外（`identity_count > 0`）。`includeEmpty: true` で tombstone も列挙できる。

### `brief`（[ADR-0017](../adr/0017-brief-period-bundle.md)）

期間バンドルを 1 round-trip で返す read tool（実体は `src/mcp/queries.ts` の `buildBrief`、`readOnlyHint: true`）。各 section は自然な timestamp 列で期間フィルタする（`sources`=observed / `tasks`=updated / `decisions`=recorded）。`inbox` だけは「現在 open」（期間非依存）。既定 window は直近 24h。

戻り値:

```jsonc
{
  "window": { "since": "...", "until": "..." },
  "sources": [/* SourceRecord */],
  "tasks": [/* TaskRecord */],
  "decisions": [/* DecisionRecord */],
  "inbox": [/* InboxRecord（state=open） */],
  "demand": [/* SlackDemandRecord */],
  "warnings": [                       // 完全性シグナル（Issue #189）
    { "key": "slack_not_configured", "message": "Slack connector not configured — ..." },
    { "key": "embedding_disabled",  "message": "embedding backend off — ..." }
  ]
}
```

`warnings`（完全性シグナル・Issue #189）は、**未設定が理由で空になった category** を区別するための注記。空 section が「本当に何も無い」のか「source 未接続だから空」なのかを host が判別できる。`buildBrief` 自体は純粋（config を知らない）で、呼び出し側（CLI / MCP server）が config から導出して渡す（`deriveBriefWarnings`）。設定済みなら空配列。

- `slack_not_configured`: `[connectors.slack]` が未設定（`self_user_id` の有無とは独立）。`demand` が常に空になる。
- `embedding_disabled`: `[embedding].backend = "disabled"`。recall 由来の素材が FTS-only に劣化する。

CLI（`suasor brief`）はヘッダに `[⚠ <key>, ...]` を付記し、`--json` では同じ `warnings` 配列をバンドルに含める。

### `catchup` skill のバックエンド方針（レビュー D1 確定）

assistant skill カタログ（[ADR-0008](../adr/0008-assistant-skills.md)）の 26 skill 中、`catchup`（「前回以降の差分」「久しぶりに確認」）だけが専用 MCP tool を持たない。**専用 tool は追加しない**。`catchup` は既存の read tool（`source.list` / `task.list` / `decision.list` / `inbox.list`）を、**host 側で保持する seen-marker（最終確認時刻）+ 各 tool の時間フィルタ**（`*After` / `*Before`）で合成して差分を組み立てる方式を既定とする。

- marker は host（Claude Code 等）側に保持する。server は永続 marker を持たない（local-first / stateless read surface を保つ）。
- 上記 4 tool が下限 inclusive の時間フィルタを備えているため、`since = last_seen` を各 `*After` に渡すだけで「前回以降の差分」を合成できる。
- server 側に永続 marker が必要と判断された場合に限り、別 Issue で `catchup` read tool（since-marker 差分 + marker 更新）を追加する。本 Issue の scope では追加しない。

## Write tools（HITL・人の承認なしに適用/送信しない）

write tool は HITL（auto-apply 経路を持たない）。`readOnlyHint: false` を付け、ホストは人の承認なしに呼ばない。いずれも writable store 供給時のみ登録される（`src/mcp/server.ts`）。

| tool | 役割 | 状態 |
|---|---|---|
| `connector.sync` | 取り込み実行 | 実装済み（#10。下記参照） |
| `propose.generate` | 返信/タスク/決定/仕分け/commitment の候補生成（mode 引数: `reply_draft` / `source_extract` / `meeting_followup` / `inbox_triage` / `commitment_scan`）。候補を `proposals` ledger に `pending` 記録 | 実装済み（#12 / #89 / #91。下記参照） |
| `propose.apply` | 承認された候補のみ適用（idempotent）。適用で ledger を `applied` に遷移 | 実装済み（#12 / #89。下記参照） |
| `propose.reject` | pending 候補を理由付きで却下（ledger を `rejected` に遷移、idempotent） | 実装済み（#89。下記参照） |
| `propose.batch` | apply / reject を 1 RPC・単一トランザクションで一括処理（atomic、apply/reject ロジック再利用） | 実装済み（#197。下記参照） |
| `task.create` | task 直接追加（ホスト側で人確認を促す） | 実装済み（#12。下記参照） |
| `task.update` | task の lifecycle 状態遷移（open / in_progress / completed / dropped） | 実装済み（下記参照） |
| `decision.record` | decision 直接記録（人自身の「これを決定として」経路） | 実装済み（#88。下記参照） |
| `inbox.add` | 受信箱項目を捕捉（state `open`） | 実装済み（#88。下記参照） |
| `inbox.triage` | open 項目を task 化 / decision 化 / discard に遷移（state machine） | 実装済み（#88。下記参照） |
| `link.add` | 2 エンティティ間に手動 link を作成（relation `manual_link`） | 実装済み（#90。下記参照） |
| `link.remove` | 手動 link を id 指定で削除（event・監査可能） | 実装済み（#90。下記参照） |
| `commitment.resolve` | open の commitment を fulfilled に遷移（[ADR-0021](../adr/0021-commitment-ledger.md)） | 実装済み（#91。下記参照） |
| `commitment.dismiss` | open の commitment を誤検出/不要として却下 | 実装済み（#91。下記参照） |
| `commitment.reopen` | resolved/dismissed の commitment を open に戻す | 実装済み（#91。下記参照） |
| `person.merge` | 2 person を 1 つに統合（identity を target へ付け替え・可逆） | 実装済み（#92。下記参照） |
| `person.split` | 1 identity を別 person へ分離（merge の逆操作） | 実装済み（#92。下記参照） |
| `draft.export` | 下書きをローカルファイルに書き出す（sandbox・送信しない・[ADR-0025](../adr/0025-local-draft-export.md)） | 実装済み（#133。下記参照） |
| `source.forget` | 取り込み source をローカル purge（redaction + projection 削除・[ADR-0026](../adr/0026-source-forgetting.md)） | 実装済み（#141。下記参照） |

### `connector.sync`（確定・write / HITL）

connector の read 専用取り込みを起動する write tool（[connector-contract](connector-contract.md) / [ADR-0007](../adr/0007-connector-contract.md)）。store を変更するため write 扱いで、`readOnlyHint: false` を付け、ホストは人の承認なしに呼ばない（auto-apply 経路なし）。CLI `suasor <connector> sync` と**同一の sync service**（`src/connectors/sync.ts` の `syncConnector`）を叩くため、どちらの経路でも取り込み挙動は同一。tool descriptor は `src/connectors/mcp-tool.ts`、server 登録は `src/mcp/server.ts`（writable store 供給時のみ登録）。

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
  "extracted": 2     // 本文を抽出テキストに差し替えた source 数（extraction 無効時は 0・ADR-0024）
}
```

`[embedding].backend` が有効なとき、新規 / 本文変更 source（`observed` + `updated`）は同一モデルで埋め込まれ vec0 に populate される（`recall.search` 用、[retrieval](retrieval.md)）。embedding は best-effort で、サイドカー失敗時も取り込み自体は成功する（FTS は反映済み・`embedded` が 0 になるだけ）。

`[extraction].backend` が有効なとき、新規 / 変更された extractable な source（Office/PDF。`local` 先行、API connector は [ADR-0034](../adr/0034-api-connector-extraction.md) で段階展開）は本文がサイドカー抽出テキストに差し替えられる（`extracted`、[ADR-0024](../adr/0024-document-extraction-sidecar.md)）。抽出も best-effort で、unsupported / oversized / 失敗時は name-only に degrade（取り込みは成功）。抽出は fingerprint 確定前・embedding 前に走るため、embedding は抽出テキストを埋め込む。

### propose ライフサイクル（状態機械）

`propose.*` 群は候補の承認/却下 HITL ループを構成する。候補は `proposals` projection（lifecycle ledger）で状態管理され、`propose.list` で状態別に閲覧できる（#89）。

```text
                propose.generate
                      │
                      ▼
   ┌──────────────[ pending ]──────────────┐
   │ propose.apply                          │ propose.reject
   │ （or propose.batch action=apply）       │ （or propose.batch action=reject）
   ▼                                        ▼
[ applied ]                            [ rejected ]
（domain entity 永続化済み）          （reason 記録・再 apply 不可）
```

- **状態列**: `pending`（生成・人の決定待ち）/ `applied`（人が承認し `propose.apply` で domain entity を永続化）/ `rejected`（人が `propose.reject` で却下、理由付き）。
- **一括処理**: `propose.batch` は apply / reject を 1 RPC・単一トランザクションで混在処理する（#197）。op ごとの状態遷移・event は `propose.apply` / `propose.reject` と同一で、トランザクション境界だけが 1 つに畳まれる（atomic）。
- **ledger と domain entity の分離**: `propose.generate` は **候補（ledger 行）のみ**を `pending` で記録し、domain entity（task / decision 等）は書かない。entity が永続化されるのは `propose.apply` のときだけ（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) の「提案 → 承認 → 適用」境界を維持）。
- **状態遷移の駆動**: `applied` 遷移は `propose.apply` が append する entity event（`TaskProposed` 等）を reducer が **`entity_id` 一致**で ledger に反映して起こす（候補 id を entity event に持たせず provenance を保つ）。`rejected` 遷移は `ProposalRejected` event。いずれも replay で同一終状態に収束する（[ADR-0002](../adr/0002-event-sourced-architecture.md)）。
- event: `ProposalGenerated`（→ `pending`）/ `ProposalRejected`（→ `rejected`）。`applied` は既存 entity event の副作用。

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

戻り値: `{ "mode": "...", "candidates": [{ "candidateId": "cand_...", "kind": "...", ... }] }`（候補は inert・未適用）。許可されない kind は tool error。

### `propose.apply`（確定・write / HITL・idempotent）

承認済み候補を domain event として永続化する write tool（実体は `src/propose/apply.ts`）。各候補は `Store.record` 経由で対応 event を append（append + projection fold が 1 transaction、[ADR-0002](../adr/0002-event-sourced-architecture.md)）。

引数（Zod）: `{ "candidates": Candidate[] }`（`propose.generate` の戻り値の候補。承認分のみ渡す）。

**idempotent**: 各候補の対象 entity id は content 由来（`src/propose/id.ts`）。適用前に projection に同 id が存在すれば **event を append せず** `skipped` を返すため、同じ承認済み集合の再適用は no-op（重複 event / projection drift なし）。`triage` のみ `(inboxId, state)` で判定し、別 state への遷移は適用する。

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

適用に伴い、対応する `proposals` ledger 行（`entity_id` 一致）は `pending` → `applied` に遷移する（#89。reducer 副作用）。`task.create` 等 ledger 行を持たない直接 entity 追加では何も遷移しない。

### `propose.list`（確定・read）

提案候補の lifecycle ledger を新しい更新順（`updated_at` DESC）に列挙する read tool（実体は `src/mcp/queries.ts` の `listProposals`、`readOnlyHint: true`）。承認/却下ループの「閲覧」側。副作用なしの SELECT のみ。

引数（Zod）:

| 引数 | 型 | 説明 |
|---|---|---|
| `state` | `enum`（任意） | `pending` / `applied` / `rejected` で絞り込み |
| `kind` | `enum`（任意） | `task` / `decision` / `reply_draft` / `triage` / `commitment` で絞り込み |
| `updatedAfter` / `updatedBefore` | ISO 8601（任意） | `updated_at` 時間窓（下限 inclusive / 上限 exclusive） |
| `limit` | `number`（任意） | 最大行数（既定 50） |

戻り値: `{ "proposals": [{ "candidateId": "cand_...", "mode": "...", "kind": "...", "entityId": "...", "summary": "...", "state": "pending", "reason": "", "createdAt": "...", "updatedAt": "..." }] }`。各行は `reason` を持ち、`state = rejected` の候補では却下理由が入る（`propose.reject` / `propose.batch` で記録された値。それ以外は空文字列）。`state = rejected` で絞れば却下済み候補と理由の一覧になる（#197）。

### `propose.reject`（確定・write / HITL・idempotent）

`pending` の候補を理由付きで却下する write tool（実体は `src/propose/reject.ts`）。`ProposalRejected` event を append し、ledger を `pending` → `rejected` に遷移させる。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）: `{ "candidateId": string, "reason"?: string }`（`candidateId` は `propose.generate` 戻り値の id）。

**状態依存の挙動**: `pending` のときのみ却下（event append）。`applied`（既に適用済み）/ `missing`（該当 ledger 行なし）は遷移させず status で報告し、`rejected` 再呼び出しは `already_rejected`（no-op、idempotent）。却下済み候補は `propose.list` で `pending` として現れなくなるため、ホストは再び承認候補として提示しない。

戻り値: `{ "candidateId": "cand_...", "status": "rejected" | "already_rejected" | "applied" | "missing" }`。

### `propose.batch`（確定・write / HITL・atomic・#197）

承認/却下 HITL ループの `propose.apply` + `propose.reject` を **1 RPC・単一トランザクション**に畳む write tool（実体は `src/propose/batch.ts`）。ホストが「これを適用・あれを却下」と一括決定したとき、2 RPC に分けると chatty かつ非アトミック（途中失敗で ledger が半端に決定される）なので、操作リストを 1 つの `sqlite.transaction()` で commit して all-or-nothing にする。

引数（Zod）: `{ "operations": Operation[] }`。`Operation` は `action` の discriminated union:

- `{ "action": "apply", "candidate": Candidate }` — 承認済みの id 付き候補を適用。apply は domain event を組むため候補ペイロード全体が必要（ledger は summary / entity_id しか持たないので candidateId だけでは不足。`propose.generate` の戻り値の候補をホストが再投入する＝`propose.apply` と同じ契約）。
- `{ "action": "reject", "candidateId": string, "reason"?: string }` — pending 候補を candidateId で却下。

op ごとのロジック・semantics は `propose.apply` / `propose.reject` をそのまま再利用する（apply は entity 存在で `skipped`・idempotent、reject は pending のときのみ却下し `applied` / `missing` / `already_rejected` は報告のみ）。差分は**トランザクション境界だけ**: バッチ全体を 1 transaction で包むため、いずれかの op が throw（不正な候補等）すると **バッチ全体が rollback** する（部分書き込みなし、[ADR-0002](../adr/0002-event-sourced-architecture.md)）。HITL（`readOnlyHint: false`、auto-apply なし、[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

戻り値:

```jsonc
{
  "results": [
    { "action": "apply",  "candidateId": "cand_...", "kind": "task", "entityId": "task_...", "status": "applied" },
    { "action": "reject", "candidateId": "cand_...", "status": "rejected" }
  ],
  "applied": 1,   // apply op で append された候補数
  "skipped": 0,   // apply op で既存により no-op だった候補数
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

戻り値: `{ "taskId": "task_...", "status": "created" | "existing" }`。`taskId` は title + provenance 由来（`dueDate` / `priority` は id に含めない＝期日変更で別 task に分裂しない、[ADR-0028](../adr/0028-task-scheduling-fields.md)）で、同一内容の再作成は `existing`（no-op、idempotent）。

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

### `decision.record`（確定・write / HITL・[Issue #88](https://github.com/ozzy-labs/suasor/issues/88)）

人が直接 decision を記録する write tool（`task.create` の decision 版）。実体は `src/propose/decision-record.ts`。`DecisionRecorded` event を append → `decisions` projection。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）:

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `title` | `string`（min 1） | — | decision タイトル |
| `rationale` | `string`（任意） | `""` | 決定理由 |
| `sourceExternalIds` | `string[]`（任意） | `[]` | provenance（→ `links`） |

戻り値: `{ "decisionId": "dec_...", "status": "created" | "existing" }`。`decisionId` は title + provenance 由来（`rationale` は id に含めない＝`propose.apply` の `decision` 候補と同一 fingerprint）で、同一内容の再記録は `existing`（no-op、idempotent）。

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

生成される task/decision の id は `task.create` / `decision.record` と同一の content 由来 id（`src/propose/id.ts`）で、同一内容なら同じ projection 行に着地する。

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
     ┌──────┐  commitment.resolve   ┌──────────┐
     │ open │ ────────────────────▶ │ resolved │
     └──────┘                       └──────────┘
        │ commitment.dismiss     ▲        │
        ▼                        │        │ commitment.reopen
   ┌───────────┐  commitment.reopen       │
   │ dismissed │ ◀────────────────────────┘
   └───────────┘
```

- **`commitment.list`（read）**: `open` / `resolved` / `dismissed` の state、`owed_by_me` / `owed_to_me` の direction、`person`（関連 person 完全一致 = 特定の相手の約束を追う）でフィルタ。`updated_at` の時間フィルタ可。`brief` / `next-actions` / `commitment-chase` skill が demand と並べて「やるべきこと」signal として取り込める。
- **`commitment.resolve`（write / HITL）**: `open` → `resolved`（`CommitmentResolved` append）。idempotent（既 `resolved` は no-op）。`dismissed` からは `invalid_state`（先に reopen）、該当なしは `missing`。
- **`commitment.dismiss`（write / HITL）**: `open` → `dismissed`（誤検出/不要、`CommitmentDismissed` append）。idempotent。`resolved` からは `invalid_state`、該当なしは `missing`。
- **`commitment.reopen`（write / HITL）**: `resolved` / `dismissed` → `open`（`CommitmentReopened` append）。既 `open` は no-op、該当なしは `missing`。

commitment id は content 由来（`title` + `direction` + provenance）なので、同一 commitment の再抽出は台帳上 no-op（idempotent）で `resolved` / `dismissed` を `open` に蘇生させない。`dueDate` / `person` は可変 context として id に含めない。

### `person.merge`（確定・write / HITL・[Issue #92](https://github.com/ozzy-labs/suasor/issues/92)）

2 person を 1 つに統合する write tool（[ADR-0022](../adr/0022-person-identity-resolution.md)）。operator が明示的に「この 2 つは同一人物」と判断する経路で、**自動 fuzzy 同定はしない**（ADR-0022 で却下）。実体は `src/propose/person-merge.ts`。`PersonsMerged` event を append → source person の identity を target に付け替え（source は `identity_count = 0` で空に）。HITL（`readOnlyHint: false`、auto-apply なし）。event log で監査可能・`person.split` で可逆。

引数（Zod）: `{ "targetPersonId": string, "sourcePersonId": string }`（いずれも min 1）。

戻り値: `{ "targetPersonId", "sourcePersonId", "movedIdentities": number, "status": "merged"|"noop" }`。**self-merge（同一 id）/ 未知の source person は tool error**。source が既に空（再 merge）は `noop`（idempotent）。

### `person.split`（確定・write / HITL・[Issue #92](https://github.com/ozzy-labs/suasor/issues/92)）

1 つの `(connector, handle)` identity を現在の person から別 person に分離する write tool（`person.merge` の逆操作、過剰 merge の訂正）。実体は `src/propose/person-split.ts`。`PersonSplit` event を append → identity の `person_id` を付け替え。`newPersonId` 省略時は identity 本来の content 由来 person（`personIdFor(connector, handle)`、= merge を巻き戻す既定の戻り先）に送る。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）: `{ "connector": string, "handle": string, "newPersonId"?: string }`（`connector` / `handle` は min 1）。

戻り値: `{ "connector", "handle", "newPersonId", "status": "split"|"noop" }`。**未知の identity は tool error**。既に target person に解決済みなら `noop`。

### `draft.export`（確定・write / HITL・[ADR-0025](../adr/0025-local-draft-export.md)）

下書き（返信 / 引き継ぎ / 告知 / 計画 等のテキスト）を**ローカルファイルに書き出す** write tool。実体は `src/export/draft-export.ts`。**送信しない・source に書き戻さない**（local-first / no-egress）。`[export].dir` の sandbox 配下のみに書き、書き込み後に **body-less `DraftExported`** event を append（content-minimization・監査）。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）:

| 引数 | 型 | 説明 |
|---|---|---|
| `content` | `string` | 書き出す下書き本文 |
| `filename` | `string`（min 1） | ファイル名（**basename のみ**。`/` `\` `..` 絶対パスは拒否） |
| `format` | `enum`（`md` / `txt` / `docx` / `pptx` / `xlsx`） | 出力形式（拡張子が無ければ付与）。`docx`/`pptx`/`xlsx` は `[export].composition` 有効時のみ（#138）。無効で要求すると tool error |
| `sourceExternalId` | `string`（任意） | provenance |

戻り値: `{ "path": "<書き出した絶対パス>", "status": "exported" }`。

- **sandbox**: `[export].dir` 配下のみ。`filename` basename 限定・traversal 拒否。`[export].dir` が無ければ作成
- **`local.roots` 重複拒否**: `[export].dir` が `[connectors.local].roots` 配下/一致だと再取り込みループになるため tool error（[ADR-0023](../adr/0023-local-filesystem-connectors.md)）
- **衝突**: 既存ファイルがあれば連番付与（`name.md` → `name-1.md`）で非破壊
- **順序**: ファイル書き込み → 成功時のみ `DraftExported` を append（write 失敗時は event を残さない）。replay は reducer no-op でファイルを再生成しない
- Office 形式（docx/pptx/xlsx）は `[export].composition` サイドカー（md→Office、抽出 [ADR-0024](../adr/0024-document-extraction-sidecar.md) の逆方向・#138）で変換してから書き出す。無効時は md/txt のみ（Office 要求は tool error）。docx を第一級、pptx/xlsx はサイドカー対応次第のベストエフォート

### `source.forget`（確定・write / HITL・[ADR-0026](../adr/0026-source-forgetting.md)）

取り込み source を**ローカルから消す** write tool（「忘れられる権利」/ 誤取り込み / 機密）。実体は `src/forget/source-forget.ts`。content-minimization（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）のため **projection だけでなく event ログ本文も消す**:

- **redaction**: 当該 `externalId` の `SourceObserved`/`SourceBodyUpdated` の `body` を `json_set(payload,'$.body','')` で空白化（append-only の明示的例外・[ADR-0026](../adr/0026-source-forgetting.md)）
- **`SourceForgotten` event**（body なし監査）を append → **reducer が `sources`/`sources_fts` を DELETE**（replay-stable: rebuild=truncate+replay でも redact 済み SourceObserved の空行を再 DELETE して absent に収束）
- **sidecar substrate**（`vec0`/`embeddings_meta`/`extraction_meta`）は tool が imperative に DELETE（replay 管理外）
- links は残す（provenance・`source.get` は null）

引数（Zod）: `externalId: string`（min 1）/ `reason?: string`（監査用）。

戻り値: `{ "externalId": "...", "status": "forgotten" | "already_forgotten" | "missing" }`。idempotent（再 forget は `already_forgotten`、未取り込みは `missing`）。HITL（`readOnlyHint: false`、auto-apply なし）。

## Tool introspection（`suasor mcp tools`）

`suasor mcp tools [--json]` は上記 tool surface を **server を起動せず**列挙する（name / read·write 区分 = `readOnlyHint` / 1 行概要）。ドキュメント生成や surface のスモークチェック用途で、Store も開かず副作用もない（[cli](cli.md)）。

カタログのデータ SSOT は `src/mcp/tool-catalog.ts`（read tool 群 + writable store 供給時のみ登録される write/HITL tool 群）。入力 schema・ハンドラの正本は引き続き `src/mcp/server.ts` の Zod 登録コード。両者の drift は `tests/mcp/tool-catalog.test.ts` が実際に登録される server の tool（name / `readOnlyHint`）と突き合わせて防ぐ（full / read-only deployment の両 surface を検証）。

## 構造化エラー + 起動時 readiness（[ADR-0031](../adr/0031-mcp-structured-errors.md)）

tool 実行の失敗は MCP 規約どおり **正常に `isError: true` を返す**（プロトコルレベル error ではない）。失敗結果は成功の `jsonResult` と対称に、**`{ code, message, hint }` の JSON を 1 つの text content** に詰める（`src/mcp/errors.ts` の `toolError` / `toToolError`）。host は `JSON.parse` して `code` で分岐し、`hint`（直し方）をユーザーに提示できる。`message` は素の text しか見ない host 向けに human-readable に残す。

`code` 体系（安定文字列・改名は破壊的変更）:

| code | 意味 | 例 |
|---|---|---|
| `INVALID_INPUT` | Zod schema を超えた入力不正 | self-loop link / self-merge / 不正 filename |
| `INVALID_STATE` | エンティティは在るが遷移不可 | `open` でない inbox item の triage |
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
- 詳細スキーマ（引数・戻り値）は実装（`src/mcp/server.ts`）の Zod を正本とする

[#11]: https://github.com/ozzy-labs/suasor/issues/11
