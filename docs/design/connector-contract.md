# Connector Contract

[ADR-0007](../adr/0007-connector-contract.md)。connector は共通 interface を実装する（read 専用）。

## Interface（暫定）

```ts
interface Connector {
  readonly name: string;                 // "github" | "slack" | ...
  readonly sourceType: string;           // projection の source_type
  sync(ctx: SyncContext): AsyncIterable<SourceRecord>;  // read 専用取り込み
}

interface SourceRecord {
  externalId: string;     // ソース横断で一意（必要なら workspace/team prefix）
  body: string;           // 抽出本文（ローカル保持）
  observedAt: string;     // ISO 8601
  meta: Record<string, unknown>;
  fingerprint?: string;   // delta なしソースの変更検知（SHA-256 等）
}
```

## 規約

- **read 専用** — ソースに書き戻さない
- **差分** — delta API があれば cursor を `SyncContext` で授受、なければ `fingerprint` 比較
- **import-clean** — connector の登録 import で重い SDK を pull しない（lazy import）
- **secrets** — トークンは keychain 経由（[config](config.md)）

## 初期 connector

GitHub(octokit) / Slack(@slack/web-api) / Microsoft Graph(@microsoft/microsoft-graph-client + @azure/msal-node) / Google(googleapis or fetch) / Box / Web(Playwright)
