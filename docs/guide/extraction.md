# Document extraction (Office/PDF → text)

Word / Excel / PowerPoint / PDF は既定では**ファイル名のみ**取り込まれ、本文は検索・要約できない。`[extraction]` サイドカーを有効にすると、取り込み時にこれらの本文を text/Markdown 化して `search` / `recall.search` / `research` / `doc-diff` / `doc-review` から参照できるようになる（[ADR-0024](../adr/0024-document-extraction-sidecar.md)）。

- **既定 disabled**。設定しなければ従来どおり name-only（base install は軽いまま）
- **ML 委譲**（[ADR-0006](../adr/0006-ml-delegation.md)）: 変換はサイドカーが行い、本体は thin client のみ（in-process パーサ無し）
- **初期スコープは `local` connector**（OS 同期フォルダ含む任意ディレクトリ）。box / google-drive / ms-graph(OneDrive) の API 経路は段階化（後続 Issue）
- **best-effort**: サイドカー停止・unsupported・oversized・失敗時は name-only に degrade し、取り込み自体は成功する

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

新規 / 変更された Office/PDF の本文がサイドカー抽出テキストに差し替わる（`SyncOutcome.extracted`）。`fingerprint` はファイル実体（mtime:size）ベースのままなので、差分検知は従来どおり。

## 既存データへの後付け / extractor 改善時の再抽出

抽出は **drift 検知**で自動再抽出される（[ADR-0024](../adr/0024-document-extraction-sidecar.md) §6）。`extraction_meta` に記録した extractor version が現行 `[extraction].version` と異なる（または未記録＝後から有効化）source は、**次の `suasor local sync` で内容未変更でも再抽出**される。

- **後から有効化**: 既に name-only で取り込み済みのファイルは、有効化後の次 sync で自動 backfill
- **サイドカー / モデル改善**: `[extraction].version` を bump すると全 source が stale 化し、次 sync で再抽出

## カバレッジ確認

```bash
suasor extraction status
# 出力例:
#   extraction: backend=markitdown version=1
#     extracted: 18  stale: 0  pending: 2  unsupported: 1  too-large: 0
#     run `suasor local sync` to (re)extract pending / stale sources
```

- `extracted` 現 version で抽出済み / `stale` 別 version（次 sync で再抽出）/ `pending` extractable だが未試行 / `unsupported` サイドカーが非対応 / `too-large` `maxBytes` 超過
- `suasor doctor` も backend / version を 1 行で表示する

## 制約

- box / google-drive / ms-graph(OneDrive) の API 実体は初期スコープ外（`local`＝OS 同期フォルダにあるものは `local` でカバー）。段階化は [ADR-0024](../adr/0024-document-extraction-sidecar.md) / epic #124
- スプレッドシート等は text 化で表構造が落ちる（まず text/Markdown 化・構造化抽出は将来）
- `maxBytes` 超過ファイルは name-only のまま
