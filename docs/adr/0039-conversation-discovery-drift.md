# 0039. Conversation discovery drift model（明示列挙 = データ最小化 / drift 可視化・silent auto-follow 非既定）

- Status: Accepted
- Date: 2026-07-01
- Deciders: Suasor maintainers
- Related: [ADR-0003](0003-local-first-and-content-minimization.md)（local-first / external-content minimization — 明示列挙の上位原則）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP/HITL 境界 — config 追記は write=HITL）, [ADR-0007](0007-connector-contract.md)（connector 契約＝read 専用・`sync` 一本）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（Slack 運用 verb / `slack conversations` discovery / per-channel cursor / 集約 warn）, [ADR-0014](0014-slack-multi-workspace.md)（`[connectors.slack.workspaces.<alias>]` — per-workspace scope boundary）, [ADR-0019](0019-slack-fetch-rate-limit-retry.md)（`slackFetch` の 429/Retry-After — sweep もこの負荷特性に乗る）, [ADR-0038](0038-multi-workspace-shared-channel-dedup.md)（共有チャンネルの owner-wins dedup — new/removed diff の共有チャンネル配置）
- Tracks: epic [#370](https://github.com/ozzy-labs/suasor/issues/370)（PR0＝本 ADR。`slack conversations --new` diff＝PR1、sync/doctor drift check＝PR2、`--apply` 追記＝PR3・任意）

## Context

Slack connector の sync 対象 conversation（public/private/mpim/im）は `config.toml` の `channels` に**明示列挙**する設計である。

- `channels: z.array(z.string()).default([])` — **明示列挙のみ**。wildcard / glob / auto-follow 機構はない（`src/connectors/slack.ts` の `SlackConnectorConfig` / `SlackWorkspaceConfig`）。
- sync は `for (const channel of ws.channels)` で config の channel だけを取り込み、**config 外は完全に無視する**（`src/connectors/slack.ts` の sync ループ）。
- `listConversations()`（`src/connectors/slack/conversations.ts`）は「token で見える全 conversation」を type 別に列挙でき、`isMember` / `isArchived` / `lastSelfPost` を付す。→ config との diff を取る素地がある。
- `renderConfigBlock` / `renderWorkspacesConfigBlock`（同 `conversations.ts`）が paste-ready な TOML fragment を生成できる（再利用可能）。

この設計は意図的だが、**新しい会話に参加/追加された時に気づき、config へ追加する UX が弱い**。現状は `suasor slack conversations` を再実行して**大量の一覧から新規分を目視で探す**しかなく、しかも**都度手動実行**しないと新規に気づけない。

初期セットアップ後、チャンネルへの新規参加は日常的に起きる。取りこぼすと「参加しているのに suasor に入ってこない」＝ demand / 検索 / brief の網羅性が落ちる。ツールは「token で見える全会話」と「config の `channels`」の両方を知っているので、**drift（config と実際に見える会話の差分）はツール側で算出できる**。**drift 検出は現状存在しない**（doctor の Slack チェックは [ADR-0038](0038-multi-workspace-shared-channel-dedup.md) の共有チャンネル重複のみ、`slack status` は config 内 channel の cursor のみ）。

**明示列挙が「データ最小化 / 取り込み範囲の明示制御」を意図した設計である**ことは、[ADR-0011](0011-slack-operational-verbs-and-readiness.md) の scope readiness capability model（granted scope の範囲でしか取り込まない）や [ADR-0014](0014-slack-multi-workspace.md) の per-workspace scope boundary に**暗黙的にあるが明文化されていない**。本 ADR はこの設計思想を SSOT として明文化し、後続 PR（既定 opt-out・cadence・follow_all 分離）の設計判断の根拠とする。

## Decision

**明示列挙は「何を取り込むかを明示制御する」意図的なプライバシー / データ最小化設計である。したがって drift への解は「黙って全自動追従」ではなく、drift を可視化して低摩擦で追加する。既定はデータ最小化を維持し、全追従は明示 opt-in にとどめる。**

### 1. 設計思想の明文化（SSOT）

**`channels` の明示列挙 = データ最小化 / 取り込み範囲の明示制御**である。ツールは token で見える全会話にアクセスできるが、**ユーザーが列挙した会話だけを取り込む**。これは [ADR-0003](0003-local-first-and-content-minimization.md) の external-content minimization を Slack 面で具体化したもので、[ADR-0011](0011-slack-operational-verbs-and-readiness.md) の capability model・[ADR-0014](0014-slack-multi-workspace.md) の per-workspace scope boundary に暗黙的にあった前提を本 ADR で明文化する。この前提の下、drift（見える会話と config の差分）は「silent に埋める」のではなく「**可視化して低摩擦で追加する**」対象とする。

### 2. Layer 1 — `slack conversations --new`（diff モード・中核）

token で見える会話と config の `channels` の**差分だけ**を表示する新 flag。

- **新規**（`isMember` だが config 未設定）を **paste-ready TOML fragment** で出力する（`renderConfigBlock` 再利用、共有チャンネルは [ADR-0038](0038-multi-workspace-shared-channel-dedup.md) の owner alias 側に配置）。
- **消失**（config にあるが到達不能 = 退出/アーカイブ/改名）も warn として surface する。
- `--workspace <alias>` に対応する（[ADR-0014](0014-slack-multi-workspace.md)）。
- **`--json` 後方互換**: `--new` は**新 flag**なので、既存 `slack conversations --json`（全列挙形状）は**不変**のまま維持する。`--new --json` のときだけ新形状 `{ new: [...], removed: [...] }` を返す（既存出力の破壊なし・回帰リスク低）。
- これにより「大量一覧から目視で新規を探す」課題を解消する（新規だけを出す）。

### 3. Layer 2 — sync 内の軽量 sweep + doctor drift check（「都度手動」を解消）

- `slack sync` 中、per-workspace で token 解決後に軽く `users.conversations` を sweep し、config 外の **member 会話**があれば **1 行集約 warn**「N 件の新規会話が未設定 — `suasor slack conversations --new` で確認」を出す。**取り込みはしない**（明示列挙のプライバシー設計を維持）、**cursor は不変**。
- `suasor doctor` にも同じ drift チェックを追加する（「N 件の新規 Slack 会話が未追加」info/warn）。doctor は既に config を parse 済みで slack config を読める（[ADR-0038](0038-multi-workspace-shared-channel-dedup.md) / #372 で追加した slack チェックと同じ経路）。
- **コスト / ノイズ対策**:
  - **opt-out**: config `[connectors.slack] discover_new = false`（既定 `true`）。multi は per-workspace override 可（`[connectors.slack.workspaces.<alias>] discover_new = false`）。CLI 側は `slack sync --no-discover` で単発無効化する。
  - **cadence（間引き）**: 毎 sync で `users.conversations` を叩くとコスト増。**既定は「前回 discovery から 24h 経過時のみ sweep」**とし、最終 sweep 時刻を per-workspace で保持する（cursor と同様の軽量メタ、または `sync_runs` 由来）。`--discover` 強制で即時 sweep する。
  - **既定 sweep 対象**: **public + private に限定**する。im/mpim はノイズが多いので `--new` の明示要求（`--types`）時のみ対象にする。
  - **perf 特性**: sweep は type 別 `users.conversations`（cursor paging）で、member 会話数（通常数十〜数百）に比例する。[ADR-0019](0019-slack-fetch-rate-limit-retry.md) の `slackFetch`（429/Retry-After）に乗せ、既存 discovery と同じ負荷特性を持つ。sync 本体（`conversations.history`）に対し相対的に小さく、cadence でさらに希薄化する。

### 4. 既定はデータ最小化を維持し、全追従は別 Issue の明示 opt-in

- 既定は**明示列挙 + drift 可視化**（データ最小化維持）であり、**silent auto-follow は既定にしない**。
- 「都度」を完全に無くしたいユーザー向けの**全追従（follow_all）は明示 opt-in の別 Issue に切り出す**（本 Issue は drift 可視化に集中）。sync ループ・privacy 設計に踏み込むため。
- **予約値の安全性**: 現行 `channels` は `z.array(z.string())`。`channels = "*"` は配列でないため型が変わり後方互換に影響する → **`channels` に混ぜず別キー（`follow_all = true`、または `channels_mode = "all"`）を推奨**し、既存 array schema を壊さない。

### 5. Layer 3 — 低摩擦な追記（任意・HITL・PR3 で判断）

diff 出力を config へ**非破壊追記**する経路（`slack conversations --new --apply` 等）は write なので [ADR-0004](0004-mcp-agent-boundary-and-hitl.md) に従い HITL（ユーザー確認）とする。明示列挙モデルは維持し、手 paste の一手間だけ削る。`config edit`（[#280](https://github.com/ozzy-labs/suasor/issues/280)）/ [ADR-0029](0029-onboarding-wizard.md) の非破壊 config append と整合が要るため、本 Issue に含めるか follow-up かは PR2 までの実装を見て判断する。

## Consequences

### Positive

- drift が可視化され、「参加しているのに suasor に入ってこない」取りこぼしを低摩擦で解消できる（demand / 検索 / brief の網羅性が保たれる）。
- `--new` は「大量一覧から目視」を「新規だけ表示」に変え、sync 内 sweep + doctor が「都度手動実行」を「気づける」に変える。
- 既定でプライバシー（明示列挙 = データ最小化）を維持し、silent auto-follow は起きない。設計思想が本 ADR で SSOT 化され、後続 PR の判断根拠になる。
- `--new` は新 flag、sweep は cursor 不変・非取り込みなので、既存の `--json` 出力・sync 挙動・cursor に回帰がない。
- sweep は opt-out + cadence + type 限定で rate-limit / ノイズを抑える（[ADR-0019](0019-slack-fetch-rate-limit-retry.md) の retry に乗る）。

### Negative / Trade-offs

- sync 内 sweep は追加 API 呼び出しである。opt-out・cadence（既定 24h）・public+private 限定で軽減するが、既定 on のぶんコストはゼロではない。
- drift の「消失」判定は token 到達性ベースなので、一時的な権限変更やアーカイブを「消失」として warn し得る（surface のみで破壊操作はしないため実害は小さい）。
- 全追従（follow_all）を別 Issue に切り出すため、「都度を完全に無くしたい」ニーズは本 Issue では満たされない（明示 opt-in 待ち）。
- opt-out key・cadence メタ（最終 sweep 時刻）・`--new`/`--discover`/`--no-discover` flag のぶん、config / CLI 表面が増える。

## Alternatives Considered

- **(a) wildcard / auto-follow を既定化する（`channels = "*"` や silent 全追従）** — 却下。token で見える全会話を黙って取り込むのは [ADR-0003](0003-local-first-and-content-minimization.md) のデータ最小化・明示制御の設計思想に正面から反する。DM/MPIM を含む機微な会話まで意図せず取り込むプライバシーリスクがあり、`z.array(z.string())` の schema も壊す。全追従は明示 opt-in の別 Issue にとどめる。
- **(b) 現状維持（`slack conversations` の手動再実行で目視）** — 却下。会話数が多いほど「全一覧を再取得して目視で新規を探す」は破綻し、「都度手動実行」も継続的な負担になる。ツールが差分を算出できるのに UX を弱いまま放置する理由がない。
- **(c) sync で新規会話を自動取り込みする** — 却下。明示列挙 = 取り込み範囲の明示制御という設計を崩す。sweep は「気づかせる（warn）」までに留め、取り込みの意思決定はユーザーに残す（cursor 不変・非取り込み）。
