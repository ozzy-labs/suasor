# MCP Surface

[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)。MCP TS SDK（`@modelcontextprotocol/sdk`、stdio transport）で公開。tool 入力は Zod schema。read / write を明確に分ける。`suasor mcp serve` で起動する。

read tool 群は `src/mcp/`（`server.ts` = tool 登録 / `queries.ts` = projection SELECT / `serve.ts` = stdio 起動）で実装。すべて副作用なし（projection を SELECT するか FTS-first search service を呼ぶだけ）で、各 tool に `readOnlyHint: true` annotation を付け、host が auto-approve できるようにしている。

## Read tools（副作用なし・エージェント自律 OK）

| tool | 役割 | 状態 |
|---|---|---|
| `search` | FTS5 全文検索（[retrieval](retrieval.md)） | #8 実装済 |
| `recall.search` | 意味検索（embedding 有効時。無効時は空 + シグナルで FTS フォールバック） | #8 で stub（degrade）／本実装 [#11] |
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

### `recall.search`（graceful degradation・ADR-0005）

引数は `search` と同じ（`query` / `limit`）。`[embedding].backend = "disabled"`（既定）のとき、**hard error にせず** `{ "hits": [], "signal": "embedding_disabled" }` を返す。host はこのシグナルを見て `search`(FTS) に寄れる。embedding backend が有効でも、本実装が入る [#11] までは同じく degrade する（host が常に FTS で動けるようにするため）。

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

本 Issue（#8）では read tool のみ実装する。write tool は後続 Issue で追加し、いずれも HITL（auto-apply 経路を持たない）。

| tool | 役割 |
|---|---|
| `propose.generate` | 返信/タスク/決定の候補生成（mode 引数: reply_draft / source_extract / meeting_followup 等） |
| `propose.apply` | 承認された候補のみ適用（idempotent） |
| `task.create` | task 追加（ホスト側で人確認を促す） |
| `connector.sync` | 取り込み実行 |

## 規約

- read = `readOnlyHint: true`（副作用なし）。write = HITL（auto-apply 経路を持たない）
- 外部送信を伴うものは write 扱い（per call HITL）
- stdio transport では stdout に JSON-RPC フレーム以外を書かない（診断は stderr）
- 詳細スキーマ（引数・戻り値）は実装（`src/mcp/server.ts`）の Zod を正本とする

[#11]: https://github.com/ozzy-labs/suasor/issues/11
