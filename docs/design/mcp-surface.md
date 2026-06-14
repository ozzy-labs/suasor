# MCP Surface

[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)。MCP TS SDK（`@modelcontextprotocol/sdk`、stdio transport）で公開。tool 入力は Zod schema。read / write を明確に分ける。`suasor mcp serve` で起動する。

read tool 群は `src/mcp/`（`server.ts` = tool 登録 / `queries.ts` = projection SELECT / `serve.ts` = stdio 起動）で実装。すべて副作用なし（projection を SELECT するか FTS-first search service を呼ぶだけ）で、各 tool に `readOnlyHint: true` annotation を付け、host が auto-approve できるようにしている。

## Read tools（副作用なし・エージェント自律 OK）

| tool | 役割 | 状態 |
|---|---|---|
| `search` | FTS5 全文検索（[retrieval](retrieval.md)） | #8 実装済 |
| `recall.search` | 意味検索（embedding 有効時の vec0 KNN。無効/未到達時は空 + シグナルで FTS フォールバック） | 実装済（[#11]） |
| `source.list` / `source.get` | source 一覧 / 本文取得 | #8 実装済 |
| `task.list` / `decision.list` / `inbox.list` | projection 一覧（時間フィルタ可） | #8 実装済 |
| `brief` | 期間サマリ（LLM 要約。委譲先で生成） | 後続 Issue |
| `graph.related` | 関連 entity 辿り | 後続 Issue |

戻り値はすべて 1 個の `text` content（JSON 文字列）。時間フィルタは各 projection の自然な timestamp 列を対象にし、**下限 inclusive (`>=`) / 上限 exclusive (`<`)**（隣接レンジの二重計上を避ける）。`iso` は ISO 8601（offset 付き）datetime。`limit` は正整数で上限 500。

### `search`（確定・FTS-first）

FTS5 全文検索（[retrieval](retrieval.md) の search service を薄くラップ）。

引数（Zod）:

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `query` | `string`（min 1） | （必須） | 検索文字列 |
| `limit` | `int > 0` | `20` | 返す最大 hit 数 |

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
  "strategy": "fts"               // "fts" | "like-fallback"（短クエリは後者）
}
```

- ランキング・短クエリ fallback・クエリエスケープの詳細は [retrieval](retrieval.md) を参照
- 意味検索が要るケースは `recall.search`（embedding 有効時）へ

### `recall.search`（意味検索・graceful degradation・ADR-0005）

引数は `search` と同じ（`query` / `limit`）。embedding backend が有効なときは query を埋め込み、`vec0` の KNN で最近傍 source を引いて `search` と同形の hits を返す（`strategy` は無く、`score` は L2 distance ＝ 小さいほど近い・best-first）。詳細は [retrieval](retrieval.md)。

graceful degradation（host は常に `signal === "embedding_disabled"` だけで FTS フォールバックを判断できる）:

- `[embedding].backend = "disabled"`（既定）/ 未実装 backend（openai・voyage）→ `{ "hits": [], "signal": "embedding_disabled", "reason": "backend_disabled" }`
- backend 有効だがサイドカー到達不能（Ollama down 等）→ `{ "hits": [], "signal": "embedding_disabled", "reason": "backend_unreachable" }`

`reason` は診断用の補助（host は `signal` を見る）。ingest 時の文書 embedding と query embedding は同一モデルで、`[embedding].model` が両者を駆動する（[config](config.md) / [retrieval](retrieval.md)）。

### `source.list` / `source.get`

- `source.list`: `sourceType?: string` / `observedAfter?: iso` / `observedBefore?: iso` / `limit?: int` → `{ "sources": [...] }`（`observed_at` DESC）。各 source は `externalId` / `sourceType` / `body` / `fingerprint` / `observedAt` / `meta`。
- `source.get`: `externalId: string`（min 1）→ `{ "source": {...} | null }`（本文込み、無ければ `null`）。

### `task.list` / `decision.list` / `inbox.list`

projection 一覧。いずれも `limit?: int`、最近更新順（対象列 DESC）。

| tool | 追加引数 | 時間窓の対象列 | 戻り値キー |
|---|---|---|---|
| `task.list` | `state?: string` | `updated_at`（`updatedAfter` / `updatedBefore`） | `{ "tasks": [...] }` |
| `decision.list` | （なし） | `recorded_at`（`recordedAfter` / `recordedBefore`） | `{ "decisions": [...] }` |
| `inbox.list` | `state?: string` | `updated_at`（`updatedAfter` / `updatedBefore`） | `{ "items": [...] }` |

### `catchup` skill のバックエンド方針（レビュー D1 確定）

assistant skill カタログ（[ADR-0008](../adr/0008-assistant-skills.md)）の 15 skill 中、`catchup`（「前回以降の差分」「久しぶりに確認」）だけが専用 MCP tool を持たない。**専用 tool は追加しない**。`catchup` は既存の read tool（`source.list` / `task.list` / `decision.list` / `inbox.list`）を、**host 側で保持する seen-marker（最終確認時刻）+ 各 tool の時間フィルタ**（`*After` / `*Before`）で合成して差分を組み立てる方式を既定とする。

- marker は host（Claude Code 等）側に保持する。server は永続 marker を持たない（local-first / stateless read surface を保つ）。
- 上記 4 tool が下限 inclusive の時間フィルタを備えているため、`since = last_seen` を各 `*After` に渡すだけで「前回以降の差分」を合成できる。
- server 側に永続 marker が必要と判断された場合に限り、別 Issue で `catchup` read tool（since-marker 差分 + marker 更新）を追加する。本 Issue の scope では追加しない。

## Write tools（HITL・人の承認なしに適用/送信しない）

write tool は HITL（auto-apply 経路を持たない）。`readOnlyHint: false` を付け、ホストは人の承認なしに呼ばない。いずれも writable store 供給時のみ登録される（`src/mcp/server.ts`）。

| tool | 役割 | 状態 |
|---|---|---|
| `connector.sync` | 取り込み実行 | 実装済み（#10。下記参照） |
| `propose.generate` | 返信/タスク/決定/仕分けの候補生成（mode 引数: `reply_draft` / `source_extract` / `meeting_followup` / `inbox_triage`） | 実装済み（#12。下記参照） |
| `propose.apply` | 承認された候補のみ適用（idempotent） | 実装済み（#12。下記参照） |
| `task.create` | task 直接追加（ホスト側で人確認を促す） | 実装済み（#12。下記参照） |

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
  "embedded": 15     // vec0 に (再)populate した source 数（embedding 無効時は 0）
}
```

`[embedding].backend` が有効なとき、新規 / 本文変更 source（`observed` + `updated`）は同一モデルで埋め込まれ vec0 に populate される（`recall.search` 用、[retrieval](retrieval.md)）。embedding は best-effort で、サイドカー失敗時も取り込み自体は成功する（FTS は反映済み・`embedded` が 0 になるだけ）。

### `propose.generate`（確定・write / HITL・[ADR-0006](../adr/0006-ml-delegation.md) ML 委譲）

ホスト LLM が生成した候補（返信下書き / task / decision / 仕分け）を **構造化して候補化**する write tool。実体は `src/propose/generate.ts`。**永続化しない**: mode ごとの許可 kind に対して候補を検証し、各候補に content 由来の安定 id（`candidateId`）を付与して返すだけ。重い推論はホスト側で行い、プロセス内で ML を実行しない（[ADR-0006](../adr/0006-ml-delegation.md)）。承認 + 適用は `propose.apply` で別途行う（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

引数（Zod）:

| 引数 | 型 | 説明 |
|---|---|---|
| `mode` | `enum`（必須） | `reply_draft` / `source_extract` / `meeting_followup` / `inbox_triage` |
| `candidates` | `Candidate[]`（min 1） | ホストが生成した候補配列 |

候補（`candidates[]`）は `kind` による判別共用体。各 mode が出せる kind は対応するアシスタント skill のフロー（[docs/skills/](../skills/)）に一致する:

| mode | 許可 kind |
|---|---|
| `reply_draft` | `reply_draft` |
| `source_extract` | `task` / `decision` / `reply_draft` |
| `meeting_followup` | `task` / `decision` |
| `inbox_triage` | `task` / `decision` / `triage` |

各 kind の形（適用先 event に 1:1 対応）:

| kind | フィールド | 適用先 event |
|---|---|---|
| `task` | `title` / `sourceExternalIds[]` | `TaskProposed` |
| `decision` | `title` / `rationale` / `sourceExternalIds[]` | `DecisionRecorded` |
| `reply_draft` | `replyToExternalId` / `body` | `ReplyDraftProposed` |
| `triage` | `inboxId` / `sourceExternalId` / `state`（`snoozed` / `done` / `dismissed`） | `InboxItemTriaged` |

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

### `task.create`（確定・write / HITL・#12 追補 D2）

人が直接 task を追加する write tool（`propose.*` がモデル提案なのに対し、人自身の「これを task に」経路。`next-actions` skill 等が使う）。実体は `src/propose/task-create.ts`。`TaskProposed` event を append → `tasks` projection。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）:

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `title` | `string`（min 1） | — | task タイトル |
| `sourceExternalIds` | `string[]`（任意） | `[]` | provenance（→ `links`） |

戻り値: `{ "taskId": "task_...", "status": "created" | "existing" }`。`taskId` は title + provenance 由来で、同一内容の再作成は `existing`（no-op、idempotent）。

## 規約

- read = `readOnlyHint: true`（副作用なし）。write = HITL（auto-apply 経路を持たない）
- 外部送信を伴うものは write 扱い（per call HITL）
- stdio transport では stdout に JSON-RPC フレーム以外を書かない（診断は stderr）
- 詳細スキーマ（引数・戻り値）は実装（`src/mcp/server.ts`）の Zod を正本とする

[#11]: https://github.com/ozzy-labs/suasor/issues/11
