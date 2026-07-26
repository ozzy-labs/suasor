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

**multi-account**（[ADR-0050](../adr/0050-multi-account-connectors.md)）: 取り込みスコープがアカウント相対の名前（google の `calendarIds = ["primary"]`、ms-graph の `user = "someone@contoso.com"`、box の `folders = ["0"]`＝**全アカウントの root が id `0`**）で書かれる connector は、`[connectors.<name>.accounts.<account>]` で複数アカウントを 1 pass で取り込む。共通実装は `src/connectors/multi-account.ts`（account 解決 + flat キー継承 / per-account secret 命名 / per-account externalId prefix / per-account エラー隔離）、対応可否は manifest の `multiAccount` が宣言し completeness test が config schema と突き合わせる。`accounts` テーブルの無い config は `default` という 1 アカウントに解決され、secret 名も externalId も**無印のまま**（既存 install は無移行）。

**削除した config キー**（[ADR-0042](../adr/0042-slack-workspace-less-connector.md) 決定 9 / [ADR-0051](../adr/0051-ingest-scope-defaults.md)）: connector が config キーを廃止したら `src/config/legacy-shapes.ts` に旧形を登録する。**登録しないと黙って壊れる** — strict 検証は「未知のキー」としか言えず（何を書けばよいか言わない）、`validate-config --fix` の safe-fix 方針は「未知キーを落とす」なので、`calendarId = "work@x"` を**削除して取り込み先を既定へ静かに戻す**。connector slice を読む全経路（`loadConfig` / `validate-config`）が strict の前にこの表を通る。**manifest のフィールドにしていないのは意図的**で、`manifest.ts` は全 connector を eager import するため config 経路に載せられないから（`manifest.ts` の module header 参照）。

## 規約

- **read 専用** — ソースに書き戻さない（[ADR-0003](../adr/0003-local-first-and-content-minimization.md)）
- **差分** — delta API があれば cursor を `SyncContext`/`SyncResult` で授受、なければ `fingerprint` 比較（sync service が body の SHA-256 を自動付与）
- **import-clean** — connector の登録 import で重い SDK を pull しない。SDK は `sync` 内で lazy import（CLI の lazy-import 規律と同じ。NFR-PRF-1）
- **secrets** — トークンは `ctx.secret(name)` で取得（keychain + env override、[config](config.md)）。config.toml には書かない
- **credential 解決は scope-emptiness 判定に先行する**（[ADR-0007](../adr/0007-connector-contract.md)） — credential を要する connector の `sync` は、`ctx.secret(...)` 解決を「取り込みスコープが空か」（`repos` / `folders` / `roots` / `urls` / `resources` / `databases` / `projects` / `jql` 等）の early-return 判定より**前**に置く。credential 皆無なら scope の空・非空に関わらず throw（exit 1）し、token 不在が空スコープの陰で silent 0-ingest + exit 0 に化けるのを防ぐ（"no silent wrong answer"）。**credential あり + スコープ空 → 従来どおり 0 件 no-op（client も build しない）** を厳守。multi-account connector（`google` / `ms-graph` / `box`。[ADR-0050](../adr/0050-multi-account-connectors.md)）は `credentials.secretNames` に **account ごとの名前**を並べ、any-of で全 account 皆無時のみ throw する（個別欠如は connector 自身の per-account skip＝warn 付き）。`web` / `local` は credential 不要のため対象外。先行事例は slack #385、#404 で github / box / google / ms-graph / notion / jira へ横展開

### actuator（write capability・read 契約とは別経路・ADR-0036）

read の `Connector` 契約は **read 専用のまま不変**。task の外部ホーム管理（[ADR-0036](../adr/0036-task-external-home.md)）が導入する egress write は、別 interface **`Actuator`**（`src/connectors/actuator.ts`：`publish` / `act`）として型・レジストリ（`actuator-registry.ts`）を分離する。1 ソースは read-only もしくは read + actuator のいずれか。actuator も import-clean（SDK は lazy import）で、write は **別スコープ（write）のトークン**（`<destination>-actuator` secret）を使う。**GitHub Issues**（`github`・REST、任意で Projects v2 board へ add + Status 更新＝GraphQL）を先行実装。Jira（REST・transition 駆動）も実装済み。Slack Lists（`slack`・Web API・items.create/update）も実装済み。

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
