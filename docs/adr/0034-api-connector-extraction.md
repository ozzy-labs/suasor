# 0034. API connector の本文抽出（Box / Google Drive / OneDrive）

- Status: Accepted
- Date: 2026-06-21
- Deciders: Suasor maintainers
- Related: [ADR-0024](0024-document-extraction-sidecar.md)（抽出 sidecar・local 先行）, [ADR-0003](0003-local-first-and-content-minimization.md)（local-first / content minimization）, [ADR-0006](0006-ml-delegation.md)（ML 委譲）, [ADR-0007](0007-connector-contract.md)（connector 契約）, [ADR-0023](0023-local-filesystem-connectors.md)（local connector）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（FTS-first）
- Tracks: epic #232（#240 ADR / #241 Box / #242 Drive / #243 OneDrive）

## Context

[ADR-0024](0024-document-extraction-sidecar.md) は Office/PDF → text 抽出 sidecar を導入したが、**初期スコープを `local` connector 限定**に絞り、API connector（`box` / `google`(Drive) / `ms-graph`(OneDrive)）は「内容 fetch + 内容ベース fingerprint を要する follow-up」として後続 Issue に明示分離した（ADR-0024 §2 / §6）。

その結果、クラウド側にしか存在しないファイル（OS 同期フォルダにマウントしていない Box / Drive / OneDrive 上のファイル）は **filename-only** のままで、`search` / `recall.search` / `research` / `find-document` / `brief` / `doc-review` が中身に対して盲目になっている。これは read 系の最大ギャップであり、Suasor の核心価値（散らばった情報を本文ベースで横断検索）を直接制約する。

ADR-0024 が `local` 先行にした技術的理由は 2 点に集約される。

1. **変更検知**: API connector は現状 fingerprint が **filename 由来**（`box` は body=ファイル名に対する SHA-256、`ms-graph` は body fingerprint）で、**内容変更を検知できない**。抽出した body を入れても、内容だけ変わったファイルの再抽出が走らない。
2. **content fetch 経路**: filename-only ingest は実体バイトをダウンロードしない。抽出には生バイトが要る（sidecar 契約 = `POST {baseUrl}/extract`、ADR-0024）。

本 ADR は、この 2 点を connector 契約（ADR-0007）と local-first（ADR-0003）の枠内でどう埋めるかを**設計として固める**。実装は本 ADR を前提に #241（Box・共通基盤確立）→ #242 ∥ #243（Drive / OneDrive、基盤に相乗り）の順で段階展開する。

## Decision

**ADR-0024 の抽出パイプラインを API connector へ拡張する。connector は ADR-0024 で既に定義済みの `extractable` ハンドル（lazy `readBytes()`）に「API 経由のバイト取得」を実装し、加えて内容ベース fingerprint を供給する。本体側のパイプライン・sidecar 契約・`extraction_meta` drift 検知・degrade 方針は ADR-0024 をそのまま再利用し、新規の抽出基盤は作らない。**

### (a) 共通基盤 = ADR-0024 の `extractable` ハンドルの再利用（新規基盤なし）

ADR-0024 で `ConnectorRecord.extractable` は **lazy `readBytes()` を持つハンドル**として汎用設計済み（`src/connectors/contract.ts`）。`local` は `readBytes` を `readFile(path)` で実装している。API connector は **同じハンドルを、`readBytes` を「API ダウンロードエンドポイント呼び出し」として実装**するだけでよい。

- sync パイプライン（`src/connectors/sync.ts` の populate フック: `extract → fingerprint/SourceBodyUpdated → embed`）は connector 非依存のまま不変。
- `extractable` は **lazy**（new/changed かつ extractor 設定時のみ `readBytes` を呼ぶ）なので、unchanged な大量ファイルに対して API download を起こさない（API egress / rate limit / コストの最小化、ADR-0019 の rate-limit 方針と整合）。
- 共通基盤は **Box（#241）で確立**し、Drive / OneDrive はこのハンドル実装の差分（download API・native 形式の export・fingerprint source）だけを足す。

### (b) 内容ベース fingerprint への切替（API connector 別）

抽出した body を再抽出可能にするため、各 API connector の `ConnectorRecord.fingerprint` を **filename 由来から実体（コンテンツ）由来に切替える**。各 API はサーバ側が計算した content hash / version トークンを提供するため、**バイトを落とさずに**内容変更を検知できる（download は抽出時の lazy `readBytes` のみ）。

| connector | 内容 fingerprint の供給源 | 備考 |
| --- | --- | --- |
| `box` | file の `sha1`（+ `size` / `modified_at`） | `list` の `fields` に `sha1,size,modified_at` を追加（現状 `id,name,modified_at,type`）。SHA-1 は Box がサーバ側で保持 |
| `google`(Drive) | binary は `md5Checksum`、native（Google Docs/Sheets/Slides）は `version` + `modifiedTime` | native は md5 を持たないため `version`（単調増加）で代替 |
| `ms-graph`(OneDrive) | `file.hashes.quickXorHash`（無ければ `cTag` / `eTag`） | quickXorHash は OneDrive が供給。`$select` に `file` を追加 |

fingerprint は **実体（ファイルの中身）に keying** することで、ファイル名を変えずに内容だけ編集したケースでも `SourceBodyUpdated` が立ち、次 sync で再抽出が走る（ADR-0024 §6 の `local` と同じ挙動を API でも成立させる）。**source identity（`external_id`）と `source_type` は不変**（ADR-0024 §4）— fingerprint の source を変えるだけで、二重取り込みや identity 破壊は起こさない。

### (c) 対象フォーマット — ADR-0024 を踏襲 + Google native の export 写像

- **binary**: `docx` / `xlsx` / `pptx` / `pdf`（ADR-0024 の `EXTRACTABLE_EXTENSIONS` をそのまま使用）。それ以外は従来どおり name-only fallback。
- **Google native（Drive のみ）**: Google Docs / Sheets / Slides は実バイトを持たないため、Drive の **export エンドポイント**で Office 形式に写像してから抽出する（`readBytes` 内で実施）。

  | native mimeType | export 先 | 抽出ルート |
  | --- | --- | --- |
  | `application/vnd.google-apps.document` | `docx` | 既存 docx ルート |
  | `application/vnd.google-apps.spreadsheet` | `xlsx` | 既存 xlsx ルート |
  | `application/vnd.google-apps.presentation` | `pptx` | 既存 pptx ルート |

  export 写像により sidecar 契約（ファイル拡張子で dispatch）を変えずに native を扱える。export 不能 / 未対応の native（Forms 等）は name-only に degrade。
- **構造化抽出は本 ADR でも対象外**（ADR-0024 と同様、まず text/Markdown 化の 80% 解。xlsx をセル/表構造で保持するのは需要確認後に別 Issue）。

### (d) API egress と local-first の整合（ADR-0003）

抽出のためのバイト取得は **read 専用 connector が、ユーザーが既に取り込みを設定したファイルを、ローカルストアに保持する目的で**ダウンロードする経路であり、ADR-0003 の「勝手に外部送信しない」に抵触しない。明示設計として次を満たす。

1. **egress 方向の不在**: connector は read 専用（ADR-0007）。ダウンロードは「外部から手元へ」の取得のみで、手元から外部への送信・書き戻しは一切ない。
2. **sidecar はローカル**: 抽出は ADR-0024 のローカル sidecar（`POST {baseUrl}/extract`、egress なし・secret 不要）。フロンティア API にバイトを送らない（ML 委譲の境界は in-process を持たないことであって外部送信ではない、ADR-0006）。
3. **opt-in**: `[extraction]` は既定 disabled（ADR-0024 §5）。API connector の抽出も extractor 設定時のみ通電。未設定環境は従来どおり filename-only。
4. **保持先はローカルストア**: 抽出 text は既存 `body` 列 + FTS に保持（ADR-0024 §8、DB スキーマ変更なし）。ダウンロードした生バイトは抽出に渡すだけで永続化しない（保持するのは派生 text のみ = content minimization、ADR-0003）。
5. **サイズ上限**: ADR-0024 §5 の `maxBytes`（入力ファイル + 抽出 text 両方）を API connector にも適用。巨大ファイルは download 前に `byteSize` で判定して name-only に degrade し、無駄な API egress を避ける。

### (e) 失敗時の degrade（silent-error 撲滅と整合）

ADR-0024 の best-effort degrade をそのまま継承する。**抽出失敗で取り込みは止めない**。

- download 失敗 / API rate limit / sidecar 停止 / unsupported / oversized → **filename-only に degrade**（current 挙動に戻すだけ）し、**warning を出す**（silent ではない。ADR-0031 の structured error 方針と整合）。
- per-source 抽出状態（`extracted` / `name-only` / `failed` / `pending` / `stale`）は ADR-0024 の `extraction_meta` にそのまま記録され、`suasor extraction status` / `list-pending` / `doctor` で可視化される（API connector も同じ roll-up に乗る）。

### (f) ML 委譲堅持（ADR-0006）

変換は引き続き sidecar、本体は SQL + thin client のみ。API connector が増えても **in-process パーサ / モデルは持たない**。download は各 connector の既存 SDK（octokit/box-sdk/googleapis/graph-client）の lazy import 経路を使い、import-clean（ADR-0007）を壊さない。`extraction_meta` は event ではない派生 substrate（ADR-0002、event log 不変）。

### (g) 段階展開と共通基盤の確立順

1. **#241 Box** — `extractable.readBytes` = Box download API、fingerprint = `sha1`。ここで「API connector が抽出に乗る共通形」を確立する（field 追加・lazy download・fingerprint 切替・degrade の型）。
2. **#242 Google Drive** — Box で確立した形に乗せ、binary は `md5Checksum`、native は export 写像 +  `version` fingerprint を追加。
3. **#243 OneDrive (ms-graph)** — 同形に乗せ、download = Graph content endpoint、fingerprint = `quickXorHash`。

Drive / OneDrive は基盤確立後に **並行可**（epic #232 の着手順）。

## Consequences

### Positive

- クラウド側にしか無い Office/PDF/Google native の中身が read 系（search/recall/research/find-document/brief/doc-review）に効くようになり、最大ギャップが閉じる。
- 新規抽出基盤を足さず、ADR-0024 の `extractable` ハンドル + sidecar + `extraction_meta` をそのまま再利用するため、本体の追加表面が薄い（DB スキーマ変更なし）。
- 内容ベース fingerprint への切替で、ファイル名を変えない内容編集も再抽出される（`local` と同じ正しさ）。
- lazy download により、unchanged な大量ファイルへの API egress / rate limit / コストを発生させない。
- 既定 disabled の opt-in なので、未設定環境は従来挙動（filename-only）を維持。

### Negative / Trade-offs

- 各 API connector の `list` field / `$select` 拡張（`sha1` / `md5Checksum` / `quickXorHash` 等）と fingerprint 切替が必要（filename 由来 fingerprint からの移行で、初回 sync は全 source が「変更扱い」になり一度 backfill が走る）。
- Google native は md5 を持たず `version` 代替のため、export 結果が安定でも version 更新で再抽出が走り得る（過剰再抽出の許容トレードオフ。誤検知は再抽出のコストのみで identity には無影響）。
- 抽出時のみとはいえ生バイト download が増えるため、API rate limit の考慮が要る（ADR-0019 の Retry-After 方針を download 経路にも適用）。
- sidecar 運用（ADR-0024 と同じ）の前提は変わらず、未導入環境では filename-only のまま。

## Alternatives Considered

- **API connector ごとに独自の抽出基盤を作る** — 却下。ADR-0024 の `extractable` ハンドルが既に汎用設計済みで、connector は `readBytes` 実装を差し替えるだけで乗れる。基盤を増やすと DRY を崩し import-clean に逆行する。
- **fingerprint を filename 由来のまま据え置く** — 却下。内容だけ変わったファイルの再抽出が走らず、抽出済み body が陳腐化する（ADR-0024 §6 が `local` 先行にした根本理由を解消できない）。
- **download した生バイトをローカルに永続キャッシュする** — 却下（初期）。content minimization（ADR-0003）に反し、ストアが膨張する。保持するのは派生 text のみ。再抽出時は再 download する（rate limit は lazy + drift 検知で限定的）。
- **フロンティア API に直接バイトを送って抽出させる** — 却下。ADR-0003（勝手な外部送信なし）/ ADR-0006（ローカル sidecar 委譲）に反する。抽出は引き続きローカル sidecar。
- **Google native を export せず name-only のまま** — 却下。Drive 上の主要ドキュメント（Docs/Sheets/Slides）が盲点として残り、ギャップが半分しか閉じない。export 写像で既存 docx/xlsx/pptx ルートに合流できる。
- **全 connector を一度に実装** — 却下。epic #232 の段階展開（Box で基盤確立 → Drive/OneDrive 横展開）に従い、共通基盤を Box で固めてから相乗りさせる方が手戻りが少ない。
