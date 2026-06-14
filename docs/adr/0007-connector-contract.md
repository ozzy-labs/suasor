# 0007. Connector contract

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor は多数のソース（チャット・メール・カレンダー・ドキュメント・コード・Web）から取り込む。ソースごとに API は違うが、取り込みの形（read 専用・差分取得・source 同一性・本文保持）は共通化したい。

## Decision

connector は共通の **contract（TypeScript interface）** を実装する:

- **read 専用** — ソースに書き戻さない（[ADR-0003](0003-local-first-and-content-minimization.md)）
- **source identity** — ソース横断で一意な `external_id`（必要に応じ workspace/team を prefix）
- **差分取得** — delta API がある場合は cursor、ない場合は本文 fingerprint（SHA-256 等）で変更検知
- **本文取得** — 取り込んだ本文はローカルに保持（`sources` projection 等）
- 取り込みは event を append（[ADR-0002](0002-event-sourced-architecture.md)）、検索は projection 経由（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)）
- connector の登録 import は重い SDK を pull しない（lazy import / import-clean）

初期対象: GitHub(octokit) / Slack(@slack/web-api) / Microsoft Graph(@microsoft/microsoft-graph-client + @azure/msal-node) / Google(googleapis or fetch) / Box / Web(Playwright)。

## Consequences

### Positive
- 新 connector を contract 実装だけで追加できる
- 取り込みの一貫性（identity / 差分 / 本文保持）が保たれる

### Negative / Trade-offs
- delta のないソースは fingerprint 比較のコスト（取得後の検知）

## Alternatives Considered
- connector ごとにアドホック実装 → 却下。identity / 差分 / import-clean の一貫性が崩れる
