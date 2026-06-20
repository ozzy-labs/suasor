# 0029. onboarding wizard (`suasor onboard`)

- Status: Accepted
- Date: 2026-06-20
- Deciders: Suasor maintainers
- Related: [ADR-0007](0007-connector-contract.md)（connector 契約）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（`auth set` / `auth test` 運用 verb）, [ADR-0027](0027-bulk-sync-orchestration.md)（`suasor sync` 一括取り込み・OS スケジューラ委譲）, [ADR-0003](0003-local-first-and-content-minimization.md) / [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（local-first / HITL）
- Tracks: #160 / Epic #153

## Context

セットアップの正しい順序は **connector 選択 → token 格納（`auth set`）→ 疎通確認（`auth test`）→ config slice 追記（`[connectors.X] enabled=true`）→ 初回 `sync` → 定期実行（OS スケジューラ）→ MCP 登録** だが、この導線は docs（[install](../guide/install.md) / [connectors](../guide/connectors.md) / [scheduling](../guide/scheduling.md)）に散在しており、ユーザーが手で繋ぐ必要がある。

とりわけ **`auth set` 成功と config slice 追記の断絶**が頻発ポイントになる。`auth set` は token を keychain に格納するが（[ADR-0011](0011-slack-operational-verbs-and-readiness.md)）、`[connectors.X]` slice の追記は手作業であり、`enabled = true` を書き忘れると `suasor sync` は「有効 connector なし」として**無音で何もしない**（[ADR-0027](0027-bulk-sync-orchestration.md) の有効判定: slice が存在し `enabled = false` でない）。token を保存したのに sync が空振りする、という分かりにくい失敗が生じる。

この断絶を docs の手順注意ではなく**構造的に**解消したい。各 verb（`auth set` / `auth test` / `sync`）は既に存在するので、ウィザードはそれらを**順序付けて繋ぐオーケストレータ**であり、新たな取り込み・認証ロジックを持つべきではない。

## Decision

**対話セットアップウィザード `suasor onboard` を新設する。既存 verb（`auth set` / `auth test` / `sync`）を内部で再利用して正しい順序で繋ぎ、唯一の新規副作用として `config.toml` への `[connectors.X]` slice 自動追記（既存値非破壊）を行う。**

1. **責務境界 — ウィザードはオーケストレータ。** 認証・疎通・取り込みのロジックは既存の `AUTH_SPECS`（`storeSecret` / `test` probe、[ADR-0011](0011-slack-operational-verbs-and-readiness.md)）と bulk-sync サービス（[ADR-0027](0027-bulk-sync-orchestration.md)）を呼ぶ。`onboard` 自身は connector SDK を一切持たず、import-clean を維持する（[ADR-0007](0007-connector-contract.md)・NFR-PRF-1）。

2. **フロー（対話時）。**
   1. connector を選択（複数可。`--connector a,b` で非対話指定も可）
   2. 各 connector の token を stdin で受け取り keychain 格納（`storeSecret` 再利用）
   3. `auth test` を即実行しスコープ / 疎通を表示（失敗しても続行可能 —token は保存済みで後から直せる）
   4. **`config.toml` に `[connectors.X]` slice を自動追記**（`enabled = true` を含む）
   5. 初回 `suasor sync --connector <selected>` を実行
   6. OS 判定して scheduler 雛形（cron 行 / launchd plist / systemd unit）を出力。`--write-cron` で crontab 追記まで（任意）
   7. MCP 登録スニペット（`claude_desktop_config.json`）を表示

3. **config 自動追記の安全性（既存値を壊さない）。** 純粋関数 `appendConnectorSlice(toml, connector, defaults)` を SSOT とする:
   - 対象 connector の `[connectors.X]` セクションが**既に存在する**場合は**追記しない**（冪等。`enabled = false` を含む既存ユーザー設定を勝手に書き換えない）
   - 存在しない場合のみ、ファイル末尾に最小 slice（`[connectors.X]` + `enabled = true` + connector 既定キーのコメント雛形）を append する
   - **行ベース append のみで TOML を再シリアライズしない。** Bun の TOML パーサは round-trip でコメント・整形・キー順を失うため、既存ファイルのテキストは一切触らず末尾追記に限定する。これにより手書きのコメントや他セクションが保全される
   - 純粋関数なので入力 TOML 文字列 → 出力 TOML 文字列としてユニットテスト可能（非破壊 / 新規追記 / 冪等を直接検証）

4. **非対話 / headless / `--json` でも壊れない。**
   - **非 TTY**（パイプ / CI）では対話プロンプトを出さず、`--connector` 指定が必須。未指定なら明確なエラーで終了する（無音で誤動作しない、[ADR-0007](0007-connector-contract.md) の "no silent wrong answer"）
   - token は stdin から read 済みのものを使い、TTY 前提のプロンプトは出さない
   - **headless（env override 前提）**: token が `SUASOR_CONNECTOR_<NAME>_<SECRET>` で渡る環境では `auth set`（keychain 格納）ステップを skip でき（`--skip-auth`）、binary 配布（keychain 非搭載、[install](../guide/install.md)）でも config 追記・sync・雛形出力は機能する
   - `--json` で各ステップの結果（auth 格納 / test 疎通 / config 追記有無 / sync 集計 / scheduler 種別）を機械可読出力する

5. **scheduler 雛形は OS 注入の純粋関数。** `renderSchedulerSnippet(os, command)` を `os` パラメータで分岐させ、OS を注入してテストする（実 OS 依存にしない）。crontab 追記（`--write-cron`）のみ副作用を持つ。

## Consequences

### Positive

- `auth set` と config slice 追記の断絶を構造的に解消する（token 保存後に sync が無音で空振りする失敗を防ぐ）
- 散在した導線（install / connectors / scheduling docs）を 1 コマンドに集約し、正しい順序を強制できる
- 既存 verb の再利用に徹するため新規の認証・取り込みロジックを増やさず、import-clean を維持
- config 追記が純粋関数 + 末尾 append 限定なので、既存ユーザー設定（コメント・他セクション）を壊さず冪等
- 非対話 / headless / binary 配布でも壊れない設計（env override・`--skip-auth`・`--json`）

### Negative / Trade-offs

- ウィザードは既存 verb の薄いオーケストレーションだが、フロー分岐（対話 / 非対話 / headless）のぶん表面積が増える
- config 追記は末尾 append のみで、生成される slice は最小（connector 固有の必須キーはコメント雛形で示すに留め、値はユーザーが埋める）。フル自動設定はしない（connector ごとに必須値が異なり、誤った既定で sync を空振りさせない方が安全）
- 対話プロンプトの UX 詳細（再入力・キャンセル）は CLI 層に閉じ、本 ADR では責務境界と安全性のみ定める

## Alternatives Considered

- **docs の手順強化のみ（コマンドを作らない）** — 却下。断絶は手順注意では構造的に解消されず、`enabled=true` 書き忘れによる無音空振りが再発する
- **config 全体を TOML パーサで round-trip 再生成して追記** — 却下。Bun の TOML パーサはコメント・整形・キー順を保持せず、既存の手書き設定を破壊する。末尾 append + 既存セクション検出で非破壊にする
- **`init` に統合（`suasor init` がそのまま connector もセットアップ）** — 却下。`init` は config + DB の冪等初期化に責務を限定する。connector 選択・token 入力・sync を含む対話フローは別コマンドに分離する方が責務が明確
- **token 含めフル自動で config に書き込む** — 却下。secret は config.toml に書かない（keychain / env override、NFR-PRV-4）。config には `enabled` と非機密キーのみ
