# MCP Surface

[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)。MCP TS SDK で公開。tool 入力は Zod schema。read / write を明確に分ける。

## Read tools（副作用なし・エージェント自律 OK）
| tool | 役割 |
|---|---|
| `search` | FTS5 全文検索（[retrieval](retrieval.md)） |
| `recall.search` | 意味検索（embedding 有効時。無効時は空 + シグナルで FTS フォールバック） |
| `source.list` / `source.get` | source 一覧 / 本文取得 |
| `task.list` / `decision.list` / `inbox.list` | projection 一覧（時間フィルタ可） |
| `brief` | 期間サマリ（LLM 要約。委譲先で生成） |
| `graph.related` | 関連 entity 辿り |

## Write tools（HITL・人の承認なしに適用/送信しない）
| tool | 役割 |
|---|---|
| `propose.generate` | 返信/タスク/決定の候補生成（mode 引数: reply_draft / source_extract / meeting_followup 等） |
| `propose.apply` | 承認された候補のみ適用（idempotent） |
| `task.create` | task 追加（ホスト側で人確認を促す） |
| `connector.sync` | 取り込み実行 |

## 規約
- read = `destructive:false`。write = HITL（auto-apply 経路を持たない）
- 外部送信を伴うものは write 扱い（per call HITL）
- 詳細スキーマ（引数・戻り値）は実装 PR で Zod として確定
