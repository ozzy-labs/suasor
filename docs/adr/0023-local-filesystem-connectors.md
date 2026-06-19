# 0023. Local-filesystem connectors（box-drive / onedrive-drive とローカル発生源）

- Status: Proposed
- Date: 2026-06-19
- Deciders: Suasor maintainers
- Related: [ADR-0007](0007-connector-contract.md)（connector 契約）, [ADR-0003](0003-local-first-and-content-minimization.md)（local-first）, [ADR-0006](0006-ml-delegation.md)（ML 委譲）
- Tracks: #94 / epic #83

## Context

opshub には `box_drive sync` / `onedrive_drive sync` があり、**OS が同期済みのローカル Box Drive / OneDrive マウント（ファイルシステム）を走査**して取り込んでいた。suasor は API 経由（`box` / `ms-graph`）のみで、ローカル FS 経路が無い。

ただし suasor の `box`（Box API）/ `ms-graph`（OneDrive 含む）connector は**同じファイル群を API から取り込める**ため、ローカル FS 経路は**データの重複経路**になりうる。port するか、するならどう connector 契約（ADR-0007）に収めるかを決める。

## Decision

**vendor 固有の box-drive/onedrive-drive は作らず、汎用の `local`（ローカルディレクトリ）connector を 1 つだけ用意する方針を採る。ただし初期実装は後回し（low priority）**（推奨）:

1. **汎用 `local` connector** — 「監視対象ディレクトリ群を走査し、変更ファイルを source として取り込む」connector を 1 つ定義する（`web` が Playwright snapshot を包むのと同じ「ローカル発生源」パターン）。Box Drive / OneDrive / Dropbox / 任意フォルダを**設定（パス）だけで**カバーでき、vendor ごとに connector を増やさない。
2. **connector 契約に準拠**（ADR-0007） — read 専用、変更検知は mtime + 本文 fingerprint（delta API が無いため）、import-clean（重い依存を持たない）。
3. **API connector との重複回避** — 同一ファイルを `box`（API）と `local`（FS）の両方で取り込むと二重化する。source identity（`external_id`）を**取得経路でなく実体（パス or content hash）基準**にし、設定で「この connector に任せる」範囲を明示する運用とする。
4. **優先度は low** — 既存 API connector で実データはカバー済みのため、parity 上の緊急度は低い。epic #83 の他項目（UX/auth/write tool）を優先し、本 connector は需要が確認できてから実装 Issue を切る。

## Consequences

### Positive

- vendor 数だけ connector が増えるのを防ぐ（1 つの `local` で N ベンダ + 任意フォルダ）
- 「ローカル発生源」を `web` と同じ契約パターンで一貫表現
- 低優先度と明示することで、limited な実装リソースを高インパクト項目に向けられる

### Negative / Trade-offs

- API connector と FS connector の二重取り込み回避は運用設定（範囲の住み分け）に依存し、設計に注意が要る
- 「OS マウント前提」のためポータビリティは環境依存（パスがマシン固有）

## Alternatives Considered

- **opshub のまま box-drive / onedrive-drive を個別 port** — 却下。vendor ごとに connector が増え、中身（ローカルディレクトリ走査）はほぼ同一。汎用 `local` に集約する方が DRY。
- **完全 drop（API connector で十分）** — 一部妥当だが却下。OS 同期フォルダにしか無いファイル（API トークンを持たない共有等）を取りこぼす。汎用 `local` を「将来オプション」として残す。
- **即時実装** — 却下。実データは既存 API connector でカバー済みで緊急度が低い。高インパクト項目を先行。
