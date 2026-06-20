# データ監査と forget（ローカル purge）

Suasor は取り込んだ source をすべてローカル SQLite に保持する（local-first・[ADR-0026](../adr/0026-source-forgetting.md)）。取り込み済みデータの**監査**と、プライバシ対応のための**手動 purge（forget）**を CLI から行える。これらは従来 MCP（agent 経由）でのみ可能だったが、`suasor source list` / `suasor source forget` で MCP クライアントなしに直接操作できる。

- `source list` は read-only（自律実行 OK）
- `source forget` は破壊的なため `--yes` での明示適用が必須（[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md) HITL）
- いずれも source の**本文・secret を表示しない**（NFR-PRV-4）

## 取り込み済み source を監査する（`source list`）

取り込み済み source を `observed_at` 降順（新しい順）で一覧する。各行は external id / `source_type` / `observed_at` のみを表示し、本文は出さない。

```bash
suasor source list                       # 直近 50 件（既定）
suasor source list --type github_issue   # source_type で絞る
suasor source list --limit 100           # 件数上限を上げる
suasor source list --since 2026-06-01T00:00:00Z --until 2026-07-01T00:00:00Z  # observed_at の窓で絞る
suasor source list --json                # {externalId, sourceType, observedAt}[] を機械可読出力
```

- `--type T`: `source_type` 完全一致（例: `github_issue` / `slack_message`）
- `--since ISO` / `--until ISO`: `observed_at` の下限（inclusive `>=`）/ 上限（exclusive `<`）
- `--limit N`: 返す行の最大数（既定 50・正の整数）
- `--json`: 本文を含まない `{externalId, sourceType, observedAt}[]` を出力（NFR-PRV-4）

本文そのものを確認したい場合は MCP の `source.get` / `find-document` skill を使う（CLI の監査一覧は本文を出さない）。

## source を forget する（`source forget`）

Suasor の「忘れられる権利」のローカル実装（[ADR-0026](../adr/0026-source-forgetting.md)）。指定 source について次を行う:

1. **event log の本文を redaction**（`SourceObserved` / `SourceBodyUpdated` の `body` を空にする・content-minimization・append-only log への監査付き例外）
2. **projection / FTS / ベクトルから削除**（`SourceForgotten` event の reducer が `sources` / `sources_fts` 行を削除。サイドカーの vec0 / `embeddings_meta` / `extraction_meta` は明示削除）
3. **本文を持たない `SourceForgotten` 監査 event を記録**（誰が・いつ forget したかは残し、本文は残さない）

`projections rebuild`（truncate + replay）後も source は復活しない（redaction 済みの `SourceObserved` が空行を再挿入し、replay された `SourceForgotten` がそれを削除する・replay-stable）。

### 確認フロー（HITL）

破壊的操作のため、`--yes` を付けない場合は**対象を preview するだけで何も適用しない**:

```bash
# 1. まず preview（本文は表示されない）
suasor source forget gh:owner/repo#1
# → would forget: gh:owner/repo#1 (github_issue)
#   (preview — re-run with --yes to apply)

# 2. 確認できたら --yes で適用
suasor source forget gh:owner/repo#1 --yes
# → forgotten: gh:owner/repo#1

# 監査理由を残す
suasor source forget gh:owner/repo#1 --reason "GDPR request" --yes
```

- `--reason R`: `SourceForgotten` 監査 event に記録する人間可読の理由
- `--yes`: 適用（省略時は preview のみ）

### べき等性とエラー

- 既に forget 済みの id を再度 forget すると no-op（`already forgotten: <id>`・exit 0）
- 一度も取り込まれていない id は `missing` として exit 1（タイプミスを暗黙に成功扱いしない）

## 関連

- [ADR-0026 source forgetting](../adr/0026-source-forgetting.md) — forget の設計・redaction 例外の根拠
- [ADR-0004 MCP agent boundary & HITL](../adr/0004-mcp-agent-boundary-and-hitl.md) — 破壊的操作の人承認
- [CLI design](../design/cli.md) — 全コマンド / フラグ一覧
