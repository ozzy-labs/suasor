# 0024. ドキュメント本文抽出 sidecar（Office/PDF → text）

- Status: Proposed
- Date: 2026-06-20
- Deciders: Suasor maintainers
- Related: [ADR-0006](0006-ml-delegation.md)（ML 委譲）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（FTS-first / embedding sidecar）, [ADR-0003](0003-local-first-and-content-minimization.md)（local-first / content minimization）, [ADR-0007](0007-connector-contract.md)（connector 契約）, [ADR-0023](0023-local-filesystem-connectors.md)（local connector）
- Tracks: #120 / epic #124

> Status: **Proposed**。本 ADR はレビュー用ドラフト。Accepted 後に実装 PR（config/client → sync 配線 → guide）へ進む。

## Context

エンジニア/アーキテクトが最も読む成果物（設計書・仕様・スプレッドシート・スライド・PDF）の**本文が取り込めていない**。

- `box` connector は **filename-only**（`src/connectors/box.ts` に "text extraction is future work" と明記）。`local` connector は `textExtensions` のテキスト系のみ本文化し、Office/PDF は **name-only**。Google Drive / OneDrive のバイナリ実体も名前+メタ止まり。
- 一方 GitHub issue/PR・Slack/Teams・メール（Gmail/Outlook）・Web（DOM text）は本文テキスト化済み。
- 結果、`search` / `recall.search` / `research` / `find-document` / `brief`、および `doc-review`（#123）が **Office/PDF/Box/Drive の中身に対して盲目**。read 系全体のボトルネック。

重い変換ライブラリ（docx/xlsx/pptx/pdf パーサ）を本体に抱えると import-clean（ADR-0007）と cold start（NFR-PRF-1）を壊す。embedding（ADR-0005/0006）と同じく**プロセス外サイドカーへ委譲**するのが整合的。

## Decision（ドラフト・レビュー対象）

**Office/PDF を text/Markdown に変換する抽出 sidecar を、embedding sidecar と同型のプロセス外委譲として導入する。既定 disabled・best-effort・source identity 不変。**

1. **対象フォーマット（初期）** — `docx` / `xlsx` / `pptx` / `pdf`。それ以外は従来どおり name-only fallback を維持。変換は markitdown 系の外部プロセス/API（本体は thin client・import-clean）。
2. **初期 connector スコープ = `local` 先行（段階化）** — 変更検知（再抽出のトリガ）は connector が**ファイル内容を見られるか**に依存する（下記 §6）。`local` は内容を読み実体ベース fingerprint を持つため抽出が正しく機能する。**box / google-drive / ms-graph(OneDrive)（API・filename-only）は内容 fetch + 内容ベース fingerprint を要する follow-up** として後続 Issue に分離する（初期スコープ外）。
3. **実行点と順序** — connector sync 時、対象ファイルに best-effort で抽出（embedding の populate と同様）。パイプライン順序は **`extract`（body を差し替え）→ fingerprint / `SourceBodyUpdated` 確定 → `embed`** とし、embedding が抽出テキストを埋め込めるようにする（`src/connectors/sync.ts` の `toEmbed` は差し替え後 body を掴む）。**抽出失敗で取り込みは止めない**（warning + name-only に degrade）。
4. **source identity 不変** — 抽出は `body` を**ファイル名から抽出テキストへ差し替える**だけ。`external_id`（実体＝パス / content hash 基準、ADR-0023 §3）も `source_type` も変えない。FTS/recall は差し替わった body を見る。
5. **config** — `[extraction]`（`backend` 既定 `disabled` / sidecar `baseUrl` 等）。disabled / 到達不能時は graceful degradation（name-only のまま・取り込み成功）。embedding の `signal` 方式に倣う。**抽出テキストにはサイズ上限**（`local` の `maxBytes` 相当）を設け、巨大 PDF が store/FTS を膨張させないようにする。
6. **変更検知と再抽出（connector 別）** — `local` は fingerprint が**ファイル実体基準**（`mtime:size:contentHash`）なので内容編集で再抽出が走る。**box/drive(API) は現状 fingerprint が filename 由来**で内容変更を検知できない → §2 のとおり段階化（内容 fetch + 内容 fingerprint が前提）。加えて **抽出器バージョン**と **per-source 抽出状態**（`extracted` / `name-only` / `failed` / `pending`）を `embeddings_meta` 相当のサイドカー meta（`extraction_meta`）に記録し、(a) 抽出を後から on にした既存 name-only source・(b) extractor 改善、を drift として再抽出する（`embeddings status/rebuild` と同型）。**event log は不変**（projection 派生のみ・ADR-0002）。
7. **共通抽出段の置き場所** — `src/connectors/sync.ts` の populate フック（embedding と同じ段）に抽出を挿し、connector ごとに重複させない。初期は `local` のみ通電、API connector は段階化（§2）。
8. **ML 委譲境界** — 変換は sidecar、本体は SQL + thin client のみ（ADR-0006）。抽出 meta（`extraction_meta`）は vec0/embeddings_meta と同様 event ではない派生 substrate（ADR-0002）。**DB スキーマ変更は不要**（既存 `body` 列 + FTS を再利用。embedding の `dim`→vec0 サイジングのような制約が無い）。

## Consequences

### Positive

- read 系（search/recall/research/find-document/brief）と `doc-review` が **`local` 配下の Office/PDF の中身**に効く（最大レバレッジ。API connector は段階化で順次）
- import-clean / cold start を保ったまま（変換はサイドカー）。DB スキーマ変更も不要（既存 body + FTS 再利用）
- 既定 disabled なので導入はオプトイン、未設定環境は従来挙動（name-only）を維持
- `local` 先行で手戻り最小（内容を読む connector のみ通電し、変更検知が自然に成立する）

### Negative / Trade-offs

- サイドカー運用（プロセス/モデル/依存）の追加。embedding と二系統のサイドカーになる（将来統合余地）
- 抽出品質はフォーマット/ツール依存（表・レイアウトの欠落）。スプレッドシートは構造が落ちる（text 化の 80% 解で開始）
- 再抽出のバージョン管理（`extraction_meta` drift 検知）の実装が要る
- **box/drive(API) の抽出は初期スコープ外**。これらの実体が `local`（OS 同期フォルダ）にも存在しない場合、当面は name-only のまま（後続 Issue で内容 fetch + 内容 fingerprint を実装するまで）

## Alternatives Considered

- **本体内で変換ライブラリを直リンク** — 却下。import-clean / cold start（NFR-PRF-1）を壊し、ADR-0006 の委譲方針に反する。
- **embedding sidecar に相乗り（同一プロセスで抽出も）** — 一部妥当だが当面は別 sidecar（責務分離）。将来の統合は別 ADR。
- **抽出しない（name-only のまま）** — 却下。read 系の最大ギャップが残り、`doc-review` も成立しない。
- **構造化抽出（xlsx をセル/表構造で保持）** — 初期スコープ外。まず text/Markdown 化、需要が確認できたら別 Issue。
- **box/drive(API) も初期から含める** — 却下（段階化）。内容 download + 内容ベース fingerprint が要り box の filename-only 方針の変更を伴う。実体が `local`（OS 同期フォルダ）にあるものは `local` connector でカバーできるため、API 経路は需要確認後に後続 Issue で対応する。
