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
| `propose.list` | 提案候補の lifecycle ledger 一覧（state: `pending` / `applied` / `rejected`、kind フィルタ可） | 実装済み（#89。下記参照） |
| `slack.demand.list` | Slack の @mention / DM 未処理 signal（`sources` への query 導出、[ADR-0012](../adr/0012-slack-demand-digest.md)） | 実装済（#48） |
| `brief` | 期間バンドル（tasks/decisions/inbox/sources/demand を期間で束ねる read tool。要約は host、[ADR-0017](../adr/0017-brief-period-bundle.md)） | 実装済み（#70） |
| `graph.related` / `graph.expand` | 既存 `links` projection 上の provenance traversal（[ADR-0018](../adr/0018-knowledge-graph-traversal.md)） | 実装済み（#71） |

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

### `slack.demand.list`（[ADR-0012](../adr/0012-slack-demand-digest.md)）

取り込み済み `slack_message` source から **query 導出**する Slack demand（@mention / DM）。`source_type='slack_message'` かつ（DM = channel id が `D` 始まり）または（mention = `body LIKE '%<@uid>%'`）。新規 projection table は持たない。

| 追加引数 | 時間窓の対象列 | 戻り値キー |
|---|---|---|
| `selfUserId?: string`（mention 用、未指定時は config の `self_user_id` にフォールバック）/ `kinds?: ("mention"\|"dm")[]` | `observed_at`（`observedAfter` / `observedBefore`） | `{ "demand": [{ ..., "kind": "mention"\|"dm" }] }` |

`selfUserId` も config も無いと mention は無効化され DM のみ返す（`kinds: ["mention"]` 指定時は空）。

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
| `propose.generate` | 返信/タスク/決定/仕分けの候補生成（mode 引数: `reply_draft` / `source_extract` / `meeting_followup` / `inbox_triage`）。候補を `proposals` ledger に `pending` 記録 | 実装済み（#12 / #89。下記参照） |
| `propose.apply` | 承認された候補のみ適用（idempotent）。適用で ledger を `applied` に遷移 | 実装済み（#12 / #89。下記参照） |
| `propose.reject` | pending 候補を理由付きで却下（ledger を `rejected` に遷移、idempotent） | 実装済み（#89。下記参照） |
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

### propose ライフサイクル（状態機械）

`propose.*` 群は候補の承認/却下 HITL ループを構成する。候補は `proposals` projection（lifecycle ledger）で状態管理され、`propose.list` で状態別に閲覧できる（#89）。

```text
                propose.generate
                      │
                      ▼
   ┌──────────────[ pending ]──────────────┐
   │ propose.apply                          │ propose.reject
   ▼                                        ▼
[ applied ]                            [ rejected ]
（domain entity 永続化済み）          （reason 記録・再 apply 不可）
```

- **状態列**: `pending`（生成・人の決定待ち）/ `applied`（人が承認し `propose.apply` で domain entity を永続化）/ `rejected`（人が `propose.reject` で却下、理由付き）。
- **ledger と domain entity の分離**: `propose.generate` は **候補（ledger 行）のみ**を `pending` で記録し、domain entity（task / decision 等）は書かない。entity が永続化されるのは `propose.apply` のときだけ（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) の「提案 → 承認 → 適用」境界を維持）。
- **状態遷移の駆動**: `applied` 遷移は `propose.apply` が append する entity event（`TaskProposed` 等）を reducer が **`entity_id` 一致**で ledger に反映して起こす（候補 id を entity event に持たせず provenance を保つ）。`rejected` 遷移は `ProposalRejected` event。いずれも replay で同一終状態に収束する（[ADR-0002](../adr/0002-event-sourced-architecture.md)）。
- event: `ProposalGenerated`（→ `pending`）/ `ProposalRejected`（→ `rejected`）。`applied` は既存 entity event の副作用。

### `propose.generate`（確定・write / HITL・[ADR-0006](../adr/0006-ml-delegation.md) ML 委譲）

ホスト LLM が生成した候補（返信下書き / task / decision / 仕分け）を **構造化して候補化**する write tool。実体は `src/propose/generate.ts`。mode ごとの許可 kind に対して候補を検証し、各候補に content 由来の安定 id（`candidateId`）を付与する。**domain entity は永続化しない**が、候補自体は `proposals` ledger に `pending` として記録する（`ProposalGenerated` event、#89）ことで `propose.list` / `propose.reject` の対象になる。重い推論はホスト側で行い、プロセス内で ML を実行しない（[ADR-0006](../adr/0006-ml-delegation.md)）。承認 + 適用は `propose.apply` で別途行う（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。content 由来 id により、同一候補の再 generate は ledger 上 no-op（idempotent）。

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

適用に伴い、対応する `proposals` ledger 行（`entity_id` 一致）は `pending` → `applied` に遷移する（#89。reducer 副作用）。`task.create` 等 ledger 行を持たない直接 entity 追加では何も遷移しない。

### `propose.list`（確定・read）

提案候補の lifecycle ledger を新しい更新順（`updated_at` DESC）に列挙する read tool（実体は `src/mcp/queries.ts` の `listProposals`、`readOnlyHint: true`）。承認/却下ループの「閲覧」側。副作用なしの SELECT のみ。

引数（Zod）:

| 引数 | 型 | 説明 |
|---|---|---|
| `state` | `enum`（任意） | `pending` / `applied` / `rejected` で絞り込み |
| `kind` | `enum`（任意） | `task` / `decision` / `reply_draft` / `triage` で絞り込み |
| `updatedAfter` / `updatedBefore` | ISO 8601（任意） | `updated_at` 時間窓（下限 inclusive / 上限 exclusive） |
| `limit` | `number`（任意） | 最大行数（既定 50） |

戻り値: `{ "proposals": [{ "candidateId": "cand_...", "mode": "...", "kind": "...", "entityId": "...", "summary": "...", "state": "pending", "reason": "", "createdAt": "...", "updatedAt": "..." }] }`。

### `propose.reject`（確定・write / HITL・idempotent）

`pending` の候補を理由付きで却下する write tool（実体は `src/propose/reject.ts`）。`ProposalRejected` event を append し、ledger を `pending` → `rejected` に遷移させる。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）: `{ "candidateId": string, "reason"?: string }`（`candidateId` は `propose.generate` 戻り値の id）。

**状態依存の挙動**: `pending` のときのみ却下（event append）。`applied`（既に適用済み）/ `missing`（該当 ledger 行なし）は遷移させず status で報告し、`rejected` 再呼び出しは `already_rejected`（no-op、idempotent）。却下済み候補は `propose.list` で `pending` として現れなくなるため、ホストは再び承認候補として提示しない。

戻り値: `{ "candidateId": "cand_...", "status": "rejected" | "already_rejected" | "applied" | "missing" }`。

### `task.create`（確定・write / HITL・#12 追補 D2）

人が直接 task を追加する write tool（`propose.*` がモデル提案なのに対し、人自身の「これを task に」経路。`next-actions` skill 等が使う）。実体は `src/propose/task-create.ts`。`TaskProposed` event を append → `tasks` projection。HITL（`readOnlyHint: false`、auto-apply なし）。

引数（Zod）:

| 引数 | 型 | 既定 | 説明 |
|---|---|---|---|
| `title` | `string`（min 1） | — | task タイトル |
| `sourceExternalIds` | `string[]`（任意） | `[]` | provenance（→ `links`） |

戻り値: `{ "taskId": "task_...", "status": "created" | "existing" }`。`taskId` は title + provenance 由来で、同一内容の再作成は `existing`（no-op、idempotent）。

## Tool introspection（`suasor mcp tools`）

`suasor mcp tools [--json]` は上記 tool surface を **server を起動せず**列挙する（name / read·write 区分 = `readOnlyHint` / 1 行概要）。ドキュメント生成や surface のスモークチェック用途で、Store も開かず副作用もない（[cli](cli.md)）。

カタログのデータ SSOT は `src/mcp/tool-catalog.ts`（read tool 群 + writable store 供給時のみ登録される write/HITL tool 群）。入力 schema・ハンドラの正本は引き続き `src/mcp/server.ts` の Zod 登録コード。両者の drift は `tests/mcp/tool-catalog.test.ts` が実際に登録される server の tool（name / `readOnlyHint`）と突き合わせて防ぐ（full / read-only deployment の両 surface を検証）。

## 規約

- read = `readOnlyHint: true`（副作用なし）。write = HITL（auto-apply 経路を持たない）
- 外部送信を伴うものは write 扱い（per call HITL）
- stdio transport では stdout に JSON-RPC フレーム以外を書かない（診断は stderr）
- 詳細スキーマ（引数・戻り値）は実装（`src/mcp/server.ts`）の Zod を正本とする

[#11]: https://github.com/ozzy-labs/suasor/issues/11
