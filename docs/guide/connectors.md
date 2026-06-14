# Connectors

Connector はソースから **read 専用**で取り込む共通実装（[ADR-0007](../adr/0007-connector-contract.md) / [connector-contract](../design/connector-contract.md)）。取り込みは event として append され、本文はローカル projection に保持され、FTS 検索の対象になる（[ADR-0002](../adr/0002-event-sourced-architecture.md) / [ADR-0003](../adr/0003-local-first-and-content-minimization.md)）。

取り込みの起動経路は 2 つ。どちらも同一の sync service を呼ぶ:

- CLI: `suasor <connector> sync`
- MCP write tool: `connector.sync`（HITL。人の承認なしに実行しない。[mcp-surface](../design/mcp-surface.md)）

## GitHub

GitHub の issue / pull request を取り込む（`octokit`）。

### 1. トークンの用意

GitHub の Personal Access Token（fine-grained 推奨、対象リポジトリの **Issues: read-only** / **Pull requests: read-only** 権限）を発行する。

トークンは 2 経路で渡せる（**config.toml には書かない**）。優先順位は env override > keychain（[config](../design/config.md) / NFR-PRV-4）:

- **OS keychain**（既定・推奨）: service `suasor` / account `connector:github:token` に格納
- **env override**（headless / Docker 用）: `SUASOR_CONNECTOR_GITHUB_TOKEN`

```bash
# env override の例
export SUASOR_CONNECTOR_GITHUB_TOKEN="github_pat_..."
```

keychain への格納はプログラム経由（`storeSecret("github", "token", <value>)`、`src/connectors/secrets.ts`）。専用 CLI は後続 Issue。

### 2. 対象リポジトリの設定

`~/.config/suasor/config.toml`（`SUASOR_CONFIG_DIR` で上書き）に `[connectors.github]` を追加する:

```toml
[connectors.github]
repos = ["owner/repo", "owner/another-repo"]  # 取り込み対象
state = "all"                                  # open | closed | all（既定 all）
# baseUrl = "https://github.example.com/api/v3"  # GitHub Enterprise の場合
```

`repos` が空の場合は何も取り込まない（トークンも要求しない）。

### 3. 取り込みの実行

```bash
suasor github sync            # 差分取り込み（前回の cursor から resume）
suasor github sync --full     # cursor を無視して全件再スキャン
suasor github sync --json     # 件数 + cursor を JSON 出力
```

出力例:

```text
github sync: 12 observed, 3 updated, 5 unchanged.
```

- **identity**: source の `external_id` は `gh:<owner>/<repo>:issue:<number>` / `gh:<owner>/<repo>:pull_request:<number>`（ソース横断で一意）
- **source_type**: `github_issue` / `github_pull_request`
- **差分検知**（FR-ING-3）: issues の `since` cursor（delta API）で更新分のみ取得し、本文 fingerprint で未変更を skip。再実行は冪等（未変更ソースは更新イベントを生まない）

### 4. 検索

取り込んだ本文（タイトル + 本文）は即座に FTS 検索の対象になる:

```bash
suasor search rocket
```

MCP 経由では `search` read tool で同じ検索ができる（[retrieval](../design/retrieval.md)）。embedding backend を有効にすると、取り込み時に本文が埋め込まれ `recall.search` の意味検索（言語跨ぎ・語彙ミスマッチ向け）も使える（[embedding setup](embedding.md)）。

## 新しい connector の追加

1. `src/connectors/<name>.ts` に `Connector` 実装と factory を書く（SDK は `sync` 内で lazy import）
2. `src/connectors/registry.ts` に `<name>: () => import("./<name>.ts")` を 1 行追加する
3. `[connectors.<name>]` の config slice を connector 側で Zod 検証する

CLI `suasor <name> sync` と MCP `connector.sync` は registry から自動的に利用可能になる。
