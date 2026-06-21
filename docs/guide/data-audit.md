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

## バックアップと復元（`export backup`）

local-first / event-sourced（event log が唯一の真実・[ADR-0002](../adr/0002-event-sourced-architecture.md)）のローカルストアを、整合した状態でバックアップする。

```bash
# DB と同ディレクトリに timestamped 名で出力（既定 sqlite 単一ファイル）
suasor export backup
# → backup written: ~/.config/suasor/suasor-backup-2026-06-21_12-00-00-000.db

# 出力先を指定 / 圧縮アーカイブ（tgz）
suasor export backup --out /backups/suasor.db
suasor export backup --format tgz --out /backups/suasor.tgz
```

- スナップショットは SQLite `VACUUM INTO` で**読み取りロック下**に取得し WAL を畳み込むため、WAL/SHM の分断（torn copy）を生まない。**無副作用**（live DB は変更しない）
- secret は含まれない（token は OS keychain・DB に載らない・NFR-PRV-4）。バックアップに資格情報は入らないので、token は別途 `auth set` で再投入する
- 既存ファイルがあれば上書き拒否（明示的に別名 / 別パスを指定する）

### 復元

`sqlite` 形式は自己完結の単一 DB なので、停止中に `[storage].dbPath` を置き換えれば復元できる。

```bash
# 1. sqlite 形式: バックアップを所定の場所へコピー
cp /backups/suasor.db ~/.config/suasor/suasor.db

# 2. tgz 形式: 展開してから配置
tar -xzf /backups/suasor.tgz -C ~/.config/suasor/
# → suasor.db が展開される

# 3. 健全性を確認
suasor doctor
suasor store info        # event 数 / projection 行数を確認
```

WAL/SHM サイドカーは復元不要（バックアップは単一ファイルに畳み込み済み）。projection / FTS / vec0 がずれた場合は `suasor projections rebuild` で event log から再構築できる。

## 設定の検証と編集（`validate-config` / `config edit`）

```bash
# config.toml の構造検証（必須欠落 / invalid / dangling / typo）
suasor validate-config
# 安全な除去のみ自動修正（unknown/typo キー・存在しない local root）
suasor validate-config --fix

# $EDITOR で編集し、保存後に schema 検証（不正なら自動で差し戻し）
suasor config edit
suasor config edit --editor nano
```

- `validate-config --fix` は**除去のみ**の保守的修正で、値の捏造はしない（`missing-required` / `invalid-value` は報告のみ・HITL [ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。コメント / 整形は保たれる
- `config edit` は保存後に loader 同等の検証を走らせ、**不正な TOML / schema 違反なら元ファイルを復元**して非ゼロ終了する（壊れた config が残らない）

## 関連

- [ADR-0026 source forgetting](../adr/0026-source-forgetting.md) — forget の設計・redaction 例外の根拠
- [ADR-0004 MCP agent boundary & HITL](../adr/0004-mcp-agent-boundary-and-hitl.md) — 破壊的操作の人承認
- [CLI design](../design/cli.md) — 全コマンド / フラグ一覧
