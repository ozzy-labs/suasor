# Connector Contract

[ADR-0007](../adr/0007-connector-contract.md)。connector は共通 interface を実装する（read 専用）。実装は `src/connectors/`（contract / sync service / registry / connector 実装）。

## Interface（確定）

`src/connectors/contract.ts`（**import-clean**: 型のみ。connector SDK を pull しない）。

```ts
interface Connector {
  readonly name: string;       // "github" | "slack" | ...（CLI verb / config key）
  readonly sourceType: string; // projection の source_type ファミリ（例 "github"）
  sync(ctx: SyncContext): AsyncIterable<SourceRecord>;  // read 専用取り込み
  finalize?(): Promise<SyncResult> | SyncResult;        // resume cursor を返す（任意）
}

interface SyncContext {
  readonly cursor: string | null;            // 前回の resume cursor（delta API 用 / 初回は null）
  secret(name: string): Promise<string | null>; // keychain + env override（NFR-PRV-4）
  readonly onProgress?: (r: SourceRecord) => void;
}

interface SourceRecord {
  readonly externalId: string;  // ソース横断で一意（必要なら workspace/team prefix）
  readonly sourceType: string;  // projection の source_type（例 "github_issue"）
  readonly body: string;        // 抽出本文（ローカル保持）
  readonly observedAt: string;  // ISO 8601
  readonly meta: Record<string, unknown>;
  readonly fingerprint?: string; // 省略時は sync service が body の SHA-256 を計算
  readonly extractable?: {        // 任意: 文書抽出ハンドル（ADR-0024）
    readonly filename: string;    //   サイドカーが拡張子で dispatch
    readonly byteSize: number;    //   oversized 入力を skip 判定
    readBytes(): Promise<Uint8Array>; // 遅延: 抽出実行時のみ読む
  };
}

interface SyncResult {
  readonly cursor: string | null; // 次回 run の resume cursor（fingerprint 系は null）
}
```

## sync service（共通取り込みコア）

`src/connectors/sync.ts` の `syncConnector(store, connector, options)` が全 connector 共通の取り込みコア。CLI `suasor <connector> sync` と MCP write tool `connector.sync` は**この同一関数**を呼ぶ（[mcp-surface](mcp-surface.md) / [ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）。

各 record について fingerprint（connector 付与、無ければ body の SHA-256）を `sources` projection と比較し、差分検知する（FR-ING-3）:

- 既存行なし → `SourceObserved` を append（新規）
- 既存行あり・fingerprint 一致 → skip（unchanged）
- 既存行あり・fingerprint 不一致 → `SourceBodyUpdated` を append（変更）

**文書抽出（ADR-0024 / [ADR-0034](../adr/0034-api-connector-extraction.md)）**: extractor 供給時、新規/変更 record が `extractable` を持てば、event append・embedding の前に本文をサイドカー抽出テキストへ差し替える（共通段。`local` 先行、API connector（box / google(Drive) / ms-graph(OneDrive)）は同じ `extractable` ハンドルに API download を実装して相乗り・ADR-0034）。`fingerprint` はファイル実体ベース（`local` は `mtime:size`、API connector は `sha1` / `md5Checksum` / `quickXorHash` 等の内容 hash・ADR-0034）で、抽出は差分検知に影響しない。best-effort で unsupported / oversized / 失敗は name-only に degrade。`readBytes` は新規/変更かつ extractor 有効時のみ呼ばれる（unchanged では読まない）。

run 終端で `ConnectorSyncCompleted`（resume cursor + count）を append。append は `Store.record`（event append + projection 畳み込みを 1 トランザクション）経由なので、検索は取り込み直後に反映される（[ADR-0002](../adr/0002-event-sourced-architecture.md)）。

## registry

`src/connectors/registry.ts` が name → **lazy factory loader** を保持する。connector の登録・一覧は SDK を読み込まない（import-clean）。connector 追加 = `() => import("./<name>.ts")` の 1 エントリ追加。

registry は併せて name → **lazy config-slice schema loader** を保持し、`loadConnectorConfigSchema(name)` で connector の `*ConnectorConfig` Zod スキーマ（`[connectors.<name>]` slice 用）を遅延取得する。`loadConfig` がこれを使って各 slice を **load 時に strict 検証**し、typo（`repos`→`repo` 等）・型不一致を `ConfigError` で fail-fast する（[config](config.md)）。connector モジュール自身は top-level が import-clean（`zod` + contract 型のみ）なので、スキーマ参照で重い SDK は pull しない。スキーマ未登録の connector は lenient（root の open record のまま）で段階導入できる。

## 規約

- **read 専用** — ソースに書き戻さない（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）
- **差分** — delta API があれば cursor を `SyncContext`/`SyncResult` で授受、なければ `fingerprint` 比較（sync service が body の SHA-256 を自動付与）
- **import-clean** — connector の登録 import で重い SDK を pull しない。SDK は `sync` 内で lazy import（CLI の lazy-import 規律と同じ。NFR-PRF-1）
- **secrets** — トークンは `ctx.secret(name)` で取得（keychain + env override、[config](config.md)）。config.toml には書かない

### actuator（write capability・read 契約とは別経路・ADR-0036）

read の `Connector` 契約は **read 専用のまま不変**。task の外部ホーム管理（[ADR-0036](../adr/0036-task-external-home.md)）が導入する egress write は、別 interface **`Actuator`**（`src/connectors/actuator.ts`：`publish` / `act`）として型・レジストリ（`actuator-registry.ts`）を分離する。1 ソースは read-only もしくは read + actuator のいずれか。actuator も import-clean（SDK は lazy import）で、write は **別スコープ（write）のトークン**（`<destination>-actuator` secret）を使う。**GitHub Issues**（`github`・REST、任意で Projects v2 board へ add + Status 更新＝GraphQL）を先行実装。Jira / Slack は後続（Slack は API spike 後）。

## 実装済み connector

全初期 connector が稼働（read 専用・import-clean）。SDK は各 connector の `sync` 内で lazy import し、build/compile では `--external` で除外する（dist は薄く、SDK は実行時に node_modules から解決）:

| name | source_type | SDK | 差分検知 | secret |
|---|---|---|---|---|
| `github` | `github_issue` / `github_pull_request` / `github_notification` | octokit | `{ issues, notifications }` `since` cursor | `token` |
| `slack` | `slack_message` | @slack/web-api | `oldest` ts cursor | `token` |
| `ms-graph` | `ms365_mail` / `ms365_calendar` / `ms365_file` / `ms365_teams_message` | @microsoft/microsoft-graph-client + @azure/msal-node | fingerprint | `clientSecret` |
| `google` | `google_drive` / `gmail_message` / `google_calendar` | googleapis | fingerprint | `refreshToken` |
| `box` | `box_file` | box-typescript-sdk-gen | fingerprint（body = ファイル名のみ） | `token` |
| `web` | `web_page` | playwright-core | snapshot fingerprint diff | （不要） |
| `local` | `local_file` | none（`fs` のみ） | `mtime:size:contentHash` fingerprint | （不要） |
| `notion` | `notion_page` / `notion_database_item` | none（`fetch` のみ） | `last_edited_time` fingerprint | `token` |
| `jira` | `jira_issue` / `jira_comment` | none（`fetch` のみ） | per-project JQL `updated >=` cursor | `token`（email は config） |

各 connector の setup（token / config slice）は [connectors guide](../guide/connectors.md)。
