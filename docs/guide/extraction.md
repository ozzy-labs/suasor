# Document extraction (Office/PDF → text)

Word / Excel / PowerPoint / PDF は既定では**ファイル名のみ**取り込まれ、本文は検索・要約できない。`[extraction]` サイドカーを有効にすると、取り込み時にこれらの本文を text/Markdown 化して `search` / `recall.search` / `research` / `doc-diff` / `doc-review` から参照できるようになる（[ADR-0024](../adr/0024-document-extraction-sidecar.md)）。

- **既定 disabled**。設定しなければ従来どおり name-only（base install は軽いまま）
- **ML 委譲**（[ADR-0006](../adr/0006-ml-delegation.md)）: 変換はサイドカーが行い、本体は thin client のみ（in-process パーサ無し）
- **対応 connector**: `local`（OS 同期フォルダ含む任意ディレクトリ）に加え、**`box`（API 経由で本文 fetch → 抽出）** が対応済み（[ADR-0034](../adr/0034-api-connector-extraction.md)）。同じサイドカー / `extraction_meta` を再利用し、connector 側で内容ベース fingerprint + lazy download を実装する。google(Drive) / ms-graph(OneDrive) の API 経路も同じ共通基盤で段階展開予定（後続 Issue #242 / #243）
- **best-effort**: サイドカー停止・unsupported・oversized・**本文 fetch 失敗**・失敗時は name-only に degrade し、取り込み自体は成功する

## サイドカーのセットアップ

抽出サイドカーは **`POST {baseUrl}/extract`** を実装する HTTP サーバ（markitdown 系）であればよい。契約は薄い:

- **リクエスト**: `content-type: application/octet-stream`、ヘッダ `x-filename: <URLエンコードしたファイル名>`、ボディは生バイト
- **レスポンス**: `200` + JSON `{ "text": "<抽出した text/Markdown>" }`。抽出不可（unsupported）なら `{ "text": null }`
- 非 2xx / 非 JSON はクライアントが失敗扱いにして name-only に degrade する

[markitdown](https://github.com/microsoft/markitdown)（docx/xlsx/pptx/pdf → Markdown）を薄い HTTP ラッパで包むのが標準的。ローカル実行（egress なし・secret 不要）。

## 有効化

```toml
# config.toml
[extraction]
backend = "markitdown"
# baseUrl = "http://localhost:8929"   # /extract が付加される
# maxBytes = 5000000                  # 抽出テキスト上限（超過は name-only）
# version = "1"                       # extractor version（bump で再抽出。下記）
```

環境変数でも上書きできる（CI / headless）:

```bash
export SUASOR_EXTRACTION__BACKEND=markitdown
# export SUASOR_EXTRACTION__BASEURL=http://sidecar:8929
```

## 取り込み（本文の抽出）

```bash
suasor local sync
# 出力例: local sync: 12 observed, 3 updated, 5 unchanged, 2 extracted.
```

新規 / 変更された Office/PDF の本文がサイドカー抽出テキストに差し替わる（`SyncOutcome.extracted`）。`local` の `fingerprint` はファイル実体（mtime:size）ベースのままなので、差分検知は従来どおり。

### Box（API connector）

```bash
suasor box sync
# 出力例: box sync: 8 observed, 1 updated, 5 unchanged, 3 extracted.
```

`box` connector は Office/PDF ファイルに対し Box API で本文を **read-only** で fetch（`downloadFile`）し、同じ抽出サイドカーに通す。共通基盤（`src/connectors/sync.ts` の抽出段）は connector 非依存で、`local` と `box` で同一経路を通る。

- **content fingerprint**: Box が返す `sha1`（content hash）を fingerprint に使うため、リネーム無しの**内容変更も検知**して再抽出される（[ADR-0024](../adr/0024-document-extraction-sidecar.md) §6 が API connector に求めた前提）。`sha1` 不在時は body（ファイル名）の SHA-256 に fallback
- **degrade**: 本文 fetch 失敗（ダウンロードエラー等）や unsupported / oversized は name-only に落ちて取り込みは成功する
- **size guard**: Box が返す `size` が `maxBytes` 超過なら fetch せず name-only（巨大ファイルで store/FTS が膨らまない）

## 既存データへの後付け / extractor 改善時の再抽出

抽出は **drift 検知**で自動再抽出される（[ADR-0024](../adr/0024-document-extraction-sidecar.md) §6）。`extraction_meta` に記録した extractor version が現行 `[extraction].version` と異なる（または未記録＝後から有効化）source は、**次の sync（`suasor local sync` / `suasor box sync`）で内容未変更でも再抽出**される。

- **後から有効化**: 既に name-only で取り込み済みのファイルは、有効化後の次 sync で自動 backfill
- **サイドカー / モデル改善**: `[extraction].version` を bump すると全 source が stale 化し、次 sync で再抽出

## カバレッジ確認

```bash
suasor extraction status
# 出力例:
#   extraction: backend=markitdown version=1
#     extracted: 18  stale: 0  pending: 2  unsupported: 1  too-large: 0
#     run the owning connector's sync (e.g. `suasor local sync` / `suasor box sync`) to (re)extract pending / stale sources
```

- `extracted` 現 version で抽出済み / `stale` 別 version（次 sync で再抽出）/ `pending` extractable だが未試行 / `unsupported` サイドカーが非対応 / `too-large` `maxBytes` 超過
- カバレッジは `local_file` / `box_file` 両 source type を横断して集計する（共通基盤、#241）
- `suasor doctor` も backend / version を 1 行で表示し、`stale` / `pending` が残っていれば保守ヒント（`extraction version drift: N` / `pending extractions: N` — owning connector の sync を促す）を WARN で出す

### どの source が待ちかを見る（drilldown）

`extraction status` は件数の roll-up。実際にどのファイルが待ちかは `extraction list-pending` で:

```bash
suasor extraction list-pending --limit 20
# 出力例:
#   2 source(s) awaiting (re)extraction:
#     [pending] report.pptx  local:/docs/report.pptx
#     [stale] spec.docx  box:file:42
#     run the owning connector's sync (e.g. `suasor local sync` / `suasor box sync`) to (re)extract these sources
```

- `pending` は未試行、`stale` は別 version で抽出済み（drift）。いずれも owning connector の sync（`suasor local sync` / `suasor box sync`）で backfill
- `--json` で `PendingExtraction[]`（`{externalId, name, reason}`）を機械可読出力

## 制約

- `box` の API 実体は本 connector で抽出対応済み（[ADR-0034](../adr/0034-api-connector-extraction.md)）。google(Drive) / ms-graph(OneDrive) の API 実体は同じ共通基盤で段階展開中（後続 Issue #242 / #243）。`local`（OS 同期フォルダ）にあるものは `local` でもカバーできる
- スプレッドシート等は text 化で表構造が落ちる（まず text/Markdown 化・構造化抽出は将来）
- `maxBytes` 超過ファイルは name-only のまま（Box は `size` メタで fetch 前に判定）
