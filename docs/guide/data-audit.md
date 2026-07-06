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
4. **再取り込み防止の tombstone を張る**（`forgotten_sources` に externalId を記録。次回 sync は該当 source を再観測せずスキップするので、上流に残っていても全文復活しない・[ADR-0026](../adr/0026-source-forgetting.md) R1-1）

上記 1〜3 は**単一トランザクション**で実行され（mid-forget クラッシュで中間状態が残らない）、削除後に `secure_delete` + `wal_checkpoint(TRUNCATE)` で free page / WAL の redact 済み平文まで物理消去する（R1-4 / R1-5）。ただし forget より前に Suasor の外へ出た copy（`draft export` 済みファイル・`export backup`・OS バックアップ・エージェント側の会話履歴）は forget の射程外。

`projections rebuild`（truncate + replay）後も source は復活しない（redaction 済みの `SourceObserved` が空行を再挿入し、replay された `SourceForgotten` がそれを削除する・replay-stable。tombstone も replay で再現される）。

### 派生 content の開示と cascade redaction（[ADR-0026](../adr/0026-source-forgetting.md) R1-2）

source 本文は propose / apply 時に**派生 entity の自由文**へ流れている（task/decision の title、decision の rationale、reply draft の本文、commitment の title、proposals ledger の `ProposalGenerated.summary`）。source だけを forget するとこれらの引用が残る。そこで forget は:

- **必ず派生 entity を開示する**（`--yes` の有無に関わらず。links provenance + proposals ledger（**reject 済み候補も含む**）+ `DraftExported` パスを辿る）。preview でも一覧が出るので、`--cascade` を付けるべきか判断できる
- `--cascade` を付けると派生 event の自由文 field を本文 redaction と同じ方式（`json_set` で `[redacted]` に置換）で消し、対応する projection 列も更新する。**同一 forget transaction・secure_delete 経路**に乗り、replay 後も維持される
- `draft_export` のパス・backup・host 会話履歴は**開示のみ**で redact しない（DB 外なので射程外）

```bash
# preview（派生 entity が一覧され、--cascade の要否が分かる）
suasor source forget gh:owner/repo#1
# → would forget: gh:owner/repo#1 (github_issue)
#     derived entities referencing this source (2):
#       - task task_ab12 (derived_from)
#       - proposal cand_cd34 (proposal)
#     ...
#   (preview — re-run with --yes to apply; add --cascade to redact derived text)

# 本文 + 派生引用まで消す
suasor source forget gh:owner/repo#1 --cascade --yes
# → forgotten: gh:owner/repo#1
#   ...
#   cascade: redacted the quoted free-text of 2 derived entities
```

> 補足: 派生 event を消してもうっかり **reject した候補の本文**（`ProposalGenerated.summary`）が残らないよう、`propose reject`（MCP `propose.reject`）は forget と独立に却下時点で当該 summary を redaction する（R1-3。reply_draft の summary は下書き全文のため）。

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
- `--cascade`: 派生 entity の自由文まで redaction する（[ADR-0026](../adr/0026-source-forgetting.md) R1-2。省略時は派生を**開示するのみ**で消さない）

### べき等性とエラー

- 既に forget 済みの id を再度 forget すると no-op（`already forgotten: <id>`・exit 0）
- 一度も取り込まれていない id は `missing` として exit 1（タイプミスを暗黙に成功扱いしない）
- connector が enabled のままなら、forget 出力に「tombstone が再取り込みを防いでいる」旨の注記が付く

## tombstone を解除する（`source unforget`）

forget は tombstone で**再取り込みを止める**（[ADR-0026](../adr/0026-source-forgetting.md) R1-1）。意図的に消したものを再び取り込みたくなった場合は `source unforget` で tombstone を解除する。

```bash
suasor source unforget gh:owner/repo#1
# → unforgotten: gh:owner/repo#1
#   (the next sync of its connector may re-ingest this source)
```

- `SourceUnforgotten` event を append し、reducer が `forgotten_sources` 行を削除する。以降その connector の sync は当該 source を通常どおり観測する
- **redaction 済みの本文は復元しない**（source が上流に残っていれば sync で戻る。既に上流から消えていれば戻らない）
- 一度も forget されていない id は `not forgotten: <id> (nothing to undo)`（no-op・exit 0）
- 破壊的でない write 操作（HITL）。preview（`--yes`）フローは持たない

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

WAL/SHM サイドカーは復元不要（バックアップは単一ファイルに畳み込み済み）。projection / FTS がずれた場合は `suasor projections rebuild` で event log から再構築できる。

> **注意（embedding 有効時）**: `projections rebuild` は replay 不能な embedding サイドカー（vec0 ベクトル＋`embeddings_meta`）を **両方消去** し、正直な「全件 pending」状態に戻す（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md) §5）。実行直後は semantic recall（意味検索）が空になるため、`suasor embeddings drain` を 1 回流して再埋め込みし復旧する（次回 sync では未変更ソースが再埋め込みされず復旧しない）。rebuild CLI もベクトルを消したときはこの案内を出力する。

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
