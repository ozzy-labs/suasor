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
- **credential 解決は scope-emptiness 判定に先行する** — 下記参照
- 取り込みは event を append（[ADR-0002](0002-event-sourced-architecture.md)）、検索は projection 経由（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)）
- connector の登録 import は重い SDK を pull しない（lazy import / import-clean）

初期対象: GitHub(octokit) / Slack(@slack/web-api) / Microsoft Graph(@microsoft/microsoft-graph-client + @azure/msal-node) / Google(googleapis or fetch) / Box / Web(Playwright)。

### credential 解決は scope-emptiness 判定に先行する

credential（token / secret 等）を要する connector の `sync` は、**credential 解決を「取り込みスコープが空か」（repos / folders / roots / urls / resources / databases / projects / jql 等が空）の判定より前に実行する**。credential が皆無なら、スコープの空・非空に関わらず **loud failure（throw → exit 1）** とする。

これは「credential 不在は無音 no-op でなく loud failure」という不変条件である。順序を誤り scope-emptiness を先に判定すると、enable 済みだが未設定の slice（スコープ空・token 未設定＝fresh-onboard 状態）で「0 件取り込み・exit 0・sync status ok」の silent success を返し、**欠落した credential が空スコープの陰に隠れる**（本 ADR の "no silent wrong answer" 違反）。

- **既存挙動の維持（回帰厳守）**: credential あり + スコープ空 → 従来どおり 0 件 no-op（client も build しない）。credential 皆無のときのみ throw に変わる。
- **multi-account connector**: 少なくとも 1 account に credential があれば全体 throw にはせず、token を欠く個別 account を per-account で skip（warning）する（per-account 隔離、[ADR-0014](0014-slack-multi-workspace.md) 準拠）。全 account 皆無のときだけ throw。
- **credential 不要な connector（`web` / `local`）は対象外** — token 概念が無いため scope 空は素直に no-op。
- 先行事例: Slack で #385 / PR #389 が実装、#404 で全 credential-connector（github / box / google / ms-graph / notion / jira）へ横展開。noop advisory（`src/connectors/noop-check.ts`・#187）は credential を見ない別レイヤ（advisory）で、本順序とは独立。

## Consequences

### Positive

- 新 connector を contract 実装だけで追加できる
- 取り込みの一貫性（identity / 差分 / 本文保持）が保たれる

### Negative / Trade-offs

- delta のないソースは fingerprint 比較のコスト（取得後の検知）

## Alternatives Considered

- connector ごとにアドホック実装 → 却下。identity / 差分 / import-clean の一貫性が崩れる
