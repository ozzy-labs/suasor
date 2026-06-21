# Draft export (local files)

`draft.export`（MCP write tool）は下書き（返信 / 引き継ぎ / 告知 / 計画テキスト）を**ローカルファイルに書き出す**（[ADR-0025](../adr/0025-local-draft-export.md)）。**送信しない・connector source に書き戻さない**（local-first / no-egress）。`reply-draft` / `handoff-draft` / `announcement-draft` / `external-brief` / `plan-draft` が作った下書きを、ユーザーの承認後にファイル化する用途。

- **HITL**: 人の承認なしに書き出さない（auto-apply なし）
- **sandbox**: `[export].dir`（既定 `<configDir>/exports/`）配下のみ。`filename` は basename（`/`・`..`・絶対パス拒否）。衝突は連番（`note.md` → `note-1.md`）で非破壊
- **`[connectors.local].roots` 配下は不可**（書き出した下書きが再取り込みされるループ防止・[ADR-0023](../adr/0023-local-filesystem-connectors.md)）
- **監査**: 本文を持たない `DraftExported` event を記録（content-minimization）

## Markdown / テキスト（サイドカー不要）

`format = "md"` / `"txt"` はそのまま書き出す。追加セットアップは不要:

```jsonc
// draft.export
{ "content": "# 返信\n\nお世話になります…", "filename": "reply-acme", "format": "md" }
// → <configDir>/exports/reply-acme.md
```

## Office 形式（docx / pptx / xlsx）— composition サイドカー

`format = "docx"` / `"pptx"` / `"xlsx"` は **md → Office 変換サイドカー**（[#138](https://github.com/ozzy-labs/suasor/issues/138)）が必要。抽出サイドカー（[extraction](extraction.md)・Office→md）の逆方向で、[ADR-0006](../adr/0006-ml-delegation.md) に沿い重い変換はサイドカーに委譲する（本体は thin client）。**docx を第一級**（md 散文→Word が自然）、pptx/xlsx は**サイドカー側の対応次第**。

> **「ベストエフォート」= サイドカーが対応していれば動く、の意（自動 fallback は無い）**: 本体側（`src/export/compose.ts` の `PandocComposer`）は要求 format をそのままサイドカーに渡し、サイドカーが非対応 format に `4xx` を返せば（または他の非 2xx でも）`ComposeError` を **throw** して `draft.export` を tool error にする。**docx への自動 fallback や部分ファイル生成は行わない**（pptx 不可なら docx で代替、といった挙動は無い）。pptx/xlsx が必要なら、その format を扱えるサイドカー（pandoc 等）を用意すること。

### サイドカーのセットアップ

`POST {baseUrl}/compose` を実装する HTTP サーバ（pandoc ラッパ等）であればよい:

- **リクエスト**: JSON `{ content: "<markdown>", format: "docx" | "pptx" | "xlsx" }`
- **レスポンス**: `200` + 変換済みファイルの**バイナリ**ボディ。非対応 format は `4xx`
- ローカル実行（egress なし・secret 不要）。[pandoc](https://pandoc.org/)（md→docx/pptx）を薄い HTTP ラッパで包むのが標準的

### 有効化

```toml
# config.toml
[export.composition]
backend = "pandoc"
# baseUrl = "http://localhost:8930"   # /compose が付加される
```

環境変数でも上書き可（CI / headless）:

```bash
export SUASOR_EXPORT__COMPOSITION__BACKEND=pandoc
# export SUASOR_EXPORT__COMPOSITION__BASEURL=http://sidecar:8930
```

### 書き出し

```jsonc
// draft.export（composition 有効時）
{ "content": "# 設計概要\n\n…", "filename": "design", "format": "docx" }
// → サイドカーで md→docx 変換 → <configDir>/exports/design.docx
```

composition が **無効**のまま Office format を要求すると tool error（md/txt は無効でも動く）。

## 制約

- 送信はしない（ローカル書き出しのみ）。ユーザーがファイルを確認して手で共有/送付する
- pptx/xlsx は md からの変換に表現上の制約がある（まず docx を確実に・構造化は将来）
- box / Gmail 等 SaaS への直接作成・送信は対象外（[ADR-0025](../adr/0025-local-draft-export.md) Alternatives で却下・別 ADR が必要）
