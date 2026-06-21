# トラブルシューティング

代表的な failure mode の **診断 → 対処** を decision tree 形式でまとめる。多くは「sync は成功しているのに検索に出ない」「件数が増えない」といった *silent* な症状で、原因が複数層にまたがる。まず下記の 2 つの read-only verb で現状を把握してから、各シナリオに進むとよい。

- `suasor doctor` — config / DB / embedding / connector が **wired か missing か** を診断する（error 検出で exit 1・[ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）
- `suasor store info` — store の **規模**（event ログ件数 / projection 行数 / DB サイズ / vec0 / FTS）を可視化する（read-only・[Issue #202](https://github.com/ozzy-labs/suasor/issues/202)）

```bash
suasor doctor                       # 全層のヘルスチェック（error があれば exit 1）
suasor store info                   # store 規模スナップショット
suasor store info --breakdown       # event ログを type 別に集計（rebuild/replay デバッグ向け）
```

## 診断ツールの読み方

### `suasor doctor`

各 check は `ok` / `info` / `warn` / `error` を持ち、**1 つでも `error` があれば exit 1**（cron / CI の gate に使える）。秘密値は出さない（NFR-PRV-4）。主な check:

- **config** — `config.toml` の有無・ロード可否
- **database** — `storage.dbPath` の存在・projection table 9 種の有無（DB は作らない＝診断専用）
- **embedding** — `[embedding].backend` の設定（`disabled` は INFO）。backend 有効時は `embedding.dim` も probe して **model 出力次元と `[embedding].dim` の一致**を検査する（後述の「次元不一致」）
- **connectors** — enabled connector の資格情報設定有無（未設定は WARN）。`auth set` 済みだが `[connectors.<name>]` を有効化していない *dangling credential* も WARN
- **maintenance** — `pending embeddings` / `stale embeddings` / `extraction version drift` 等の drainable backlog を WARN で surface（保守ヒント・exit code には影響しない）

### `suasor store info --breakdown`

event ログを `type` 別に集計（`COUNT(*) GROUP BY type`、read-only）して表示する（[Issue #270](https://github.com/ozzy-labs/suasor/issues/270)）。rebuild / replay デバッグや「どの connector から何が取り込まれたか」の構成把握に使う。例:

```text
  events by type:
    SourceObserved           1240
    SourceBodyUpdated         312
    ConnectorSyncCompleted     48
```

- `SourceObserved` / `SourceBodyUpdated` が 0 → そもそも取り込めていない（→ [sync 0 件](#sync-が-0-件取り込めていない)）
- `SourceObserved` はあるのに `projections` の `sources` 行数が極端に少ない → projection drift の疑い（`suasor projections rebuild` で event ログから再構築）
- `--json` 併用で `eventBreakdown`（`{type, count}[]`）を機械可読出力

## sync が 0 件（取り込めていない）

`suasor sync` / `suasor <connector> sync` が exit 0 なのに件数が増えない。

1. **scope が未設定** — connector が「どこを見るか」を指定していない。GitHub の `repos` / Google の `calendars` / Box の `folders` などが空だと、auth が通っていても **取り込み対象 0** になる。
   - discovery verb で可視範囲を列挙し、paste-ready な config ブロックを得る:

     ```bash
     suasor github repos       # 可視リポジトリ → [connectors.github] ブロック
     suasor google calendars   # 可視カレンダー → [connectors.google] ブロック
     suasor box folders        # 可視 folder ツリー → [connectors.box] ブロック
     ```

   - 詳細は [connectors guide](connectors.md)。`owner/repo` 等を手書きすると typo で silent 0 件になりやすい。
2. **cursor がすでに最新** — 増分 sync は保存済み cursor 以降のみを取り込む。新規が無ければ 0 件は正常。全件再スキャンするには `--full`:

   ```bash
   suasor <connector> sync --full   # 保存済み cursor を無視して全件再スキャン
   ```

3. **connector が enabled になっていない** — `[connectors.<name>]` slice が無い / `enabled = false`。`suasor doctor` の connectors check（dangling credential WARN を含む）と `suasor connectors list` で確認する。
4. **部分失敗が exit 0 に隠れていないか** — 内部に複数取り込み単位を持つ connector（Slack のマルチ workspace 等）は部分失敗を `SyncOutcome.partialFailure` で報告し **exit 1** にする（[ADR-0014](../adr/0014-slack-multi-workspace.md)）。人間可読出力の workspace 別サマリ（`workspaces: acme=ok, beta=failed ...`）を確認する。

## 検索に出てこない（FTS は OK だが recall が空）

`suasor search`（FTS5 全文検索）には出るのに `recall.search`（意味検索）が空、または embedding を有効化したのに recall が効かない。embedding は **任意の上乗せ** で、無効でも FTS は完全に動く（[ADR-0005](../adr/0005-fts-first-retrieval-embedding-sidecar.md)）。

### embedding sidecar down / `embedding_disabled`

- backend が **未設定（既定 disabled）** の場合、`recall.search` は空 + `embedding_disabled` シグナルを返し、host は `search`（FTS）に寄る（graceful degradation）。これは設計どおりの挙動。
- backend を有効化しているのに recall が空 → サイドカー（Ollama）が落ちている / 外部 API キーが解決できていない可能性。`suasor doctor` の embedding check で surface される（API キー未解決は readiness WARN）。
- sync 実行中の embedding は **best-effort**。サイドカー失敗は warning（stderr）に留め、取り込み自体は成功する（`warning: <connector> embedding skipped: ...`）。後から埋め込みを backfill するには:

  ```bash
  suasor embeddings drain      # 未埋め込み（pending）source を埋める
  suasor embeddings status     # 埋め込みカバレッジ / pending / stale を確認
  ```

- セットアップ詳細は [embedding guide](embedding.md)。

### 次元不一致（model dim ≠ config dim → recall が空）

**最も気づきにくい failure mode**（[Issue #267](https://github.com/ozzy-labs/suasor/issues/267)）。`[embedding].dim` は vec0 テーブルの次元を決める。これが **model の実際の出力次元と食い違う** と、すべての vector insert が失敗し、**recall が silent に空**へ劣化する（sync は exit 0 のまま）。

- **診断**: `suasor doctor` が `embedding.dim` を probe（model に 1 件埋め込ませて出力長を比較）して error で報告する:

  ```text
  [ERR ] embedding.dim   model "text-embedding-3-small" returns 1536-dim but [embedding].dim is 1024;
                         vector inserts fail and recall degrades to empty. Set [embedding].dim = 1536
                         (needs a fresh DB / delete + rebuild + re-sync). See docs/guide/embedding.md.
  ```

- **対処**: `[embedding].dim` を **model の出力次元に合わせる**（bge-m3=1024 / nomic-embed-text=768 / text-embedding-3-small=1536 等）。

  ```toml
  [embedding]
  backend = "ollama"
  model = "bge-m3"
  dim = 1024            # ← model の出力次元と必ず一致させる
  ```

- **重要**: `dim` は vec0 のスキーマを規定するため、**後から変更すると既存ベクトルと整合しない**。新しい DB を作るか、`dim` を直したうえで DB を作り直し → `suasor sync`（再取り込み）/ `suasor embeddings rebuild`（再埋め込み）が必要。
- `model` は ingest と query で必ず同一にする（ベクトル空間整合）。

## rate-limit / backoff（sync が遅い / 429 が出る）

connector / embedding API が 429（Too Many Requests）や 5xx を返すとき。

### 自動 retry / backoff の挙動（A/B）

- connector の auth / fetch と embedding 呼び出しは共通の retry policy（`src/util/retry.ts`）を通る。**429 / 5xx を指数バックオフ + full jitter で自動リトライ**し、`Retry-After` ヘッダを尊重する（最大待機は 60 秒で clamp）。既定の試行回数は 3。
- google / box / ms-graph は token 交換等で `fetchWithRetry` を使い、googleapis / microsoft-graph SDK 側も既定の RetryHandler で 429 をリトライする（[Issue #269](https://github.com/ozzy-labs/suasor/issues/269)）。
- embedding 側は `[embedding].maxRetries`（既定 3）/ `[embedding].requestTimeoutMs`（既定 60000ms、超過は abort→retry）で調整できる:

  ```toml
  [embedding]
  maxRetries = 3            # 429 / 5xx / timeout の最大リトライ回数
  requestTimeoutMs = 60000  # per-request timeout（ms、0 で無効）
  ```

### `--concurrency` の調整（B）

`suasor sync`（一括取り込み）は **connector 間を bounded pool で並列**実行する（別 API ホスト＝独立 rate-limit バケットのため・[ADR-0027](../adr/0027-bulk-sync-orchestration.md) / [Issue #269](https://github.com/ozzy-labs/suasor/issues/269)）。**connector 内の per-resource は直列を維持**する（googleapis / graph.microsoft はクォータ共有のため・[ADR-0014](../adr/0014-slack-multi-workspace.md)）。

```bash
suasor sync                      # 既定並列度 4
suasor sync --concurrency 2      # 並列度を下げる（rate-limit / サイドカー contention 緩和）
suasor sync --concurrency 8      # 並列度を上げる（8 超は警告のみ）
```

- 既定は 4。`> 8` を指定すると「shared sidecar / API rate limit に contend しうる」旨を warning（exit はしない）。
- **429 が頻発する / 共有サイドカー（embedding・extraction）が詰まる** → `--concurrency` を下げる。
- **ネットワーク待ちが支配的で API rate-limit に余裕がある** → 上げる。多くの用途では既定 4 で十分。
- `--no-continue-on-error`（fail-fast）は順序依存の意味を保つため **直列実行**になる（並列度は無視）。

## projection と event ログが食い違う

projection（読みモデル）は event ログから replay で再構築できる（[ADR-0002](../adr/0002-event-sourced-architecture.md)）。`store info` の `events` / `events by type` に対して `projections` の行数が不自然に少ない / 古い場合:

```bash
suasor store info --breakdown    # event 数と projection 行数の乖離を確認
suasor projections rebuild       # event ログを replay して projection を再構築
suasor db migrate                # projection スキーマ未適用なら先に migrate
```

projection は捨てて作り直せる（event ログが真実）。困ったらまず `projections rebuild` を試す。

## さらに調べる

- 全コマンド / フラグの一覧: [docs/design/cli.md](../design/cli.md)
- embedding / 意味検索のセットアップ: [embedding guide](embedding.md)
- connector 別のセットアップ: [connectors guide](connectors.md)
- 定期実行と失敗監視: [scheduling guide](scheduling.md)
- 取り込みデータの監査 / purge: [data-audit guide](data-audit.md)
