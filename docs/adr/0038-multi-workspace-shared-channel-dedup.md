# 0038. Multi-workspace shared-channel de-duplication（owner-wins・global channel ID キー）

- Status: Accepted
- Date: 2026-07-01
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event-sourced / externalId 冪等性）, [ADR-0007](0007-connector-contract.md)（connector 契約＝read 専用・sync 一本）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（per-channel cursor / unreachable 集約 warn）, [ADR-0012](0012-slack-demand-digest.md)（`slack.demand.list` — 重複が demand へ波及）, [ADR-0014](0014-slack-multi-workspace.md)（`[connectors.slack.workspaces.<alias>]` — 本問題の発生源）, [ADR-0026](0026-source-forgetting.md)（既存重複 source の cleanup 経路）, [ADR-0036](0036-task-external-home.md)（task read-back が `sources.external_id` を join キーに使う）, [ADR-0037](0037-slack-name-enrichment.md)（`slack_channels` projection / team_id）
- Tracks: epic [#363](https://github.com/ozzy-labs/suasor/issues/363)（PR0＝本 ADR。sync 時 owner-wins dedup＝PR1、discovery dedup/マーキング＝PR2、config/doctor warn＝PR3、既存重複 cleanup ガイド＝PR4）

## Context

[ADR-0014](0014-slack-multi-workspace.md) で `[connectors.slack.workspaces.<alias>]` による multi-workspace 取り込みを導入した。alias ごとに `team` / `channels` / token を持ち、sync は全 alias を直列に走査する。

Enterprise Grid では **複数 workspace に共有された 1 チャンネル**が一般的である（部門横断・社外 BP 連携など）。共有チャンネルは Grid 全体でグローバル一意な 1 つの channel ID（`C…`）を持つが、suasor は workspace alias ごとに独立して取り込むため、同一メッセージが **alias の数だけ別 source として二重化**する。

根本原因は source identity が team で名前空間化されている点にある。`toRecord`（`src/connectors/slack.ts`）は `externalId = slack:<team>:<channel>:<ts>` を生成し、`team` は alias ごとに設定した `team` ラベルである。同一メッセージが `slack:T_A:C123:ts` と `slack:T_B:C123:ts` の**別 externalId で二重 source 化**し、fingerprint は externalId 単位の冪等性判定なので横断 dedup されない。sync ループ（外側 `for (const ws of workspaces)` × 内側 `for (const channel of ws.channels)`）にも、discovery（`slack conversations` の org-level auto-enumerate merge / `renderWorkspacesConfigBlock`）にも横断 dedup がない。

症状として、同一メッセージが複数 source として存在し、[ADR-0012](0012-slack-demand-digest.md) の `slack.demand.list` / `search` / `brief` / `personal-brief` に重複ヒットする。triage の信頼性が下がる。ユーザーは「どの alias にどのチャンネルを書くか」を手作業で調整しないと重複するが、ツールは channel ID のグローバル一意性を知っているのだから、**重複はツール側で吸収すべき**である。

なお `slack_channels` projection（[ADR-0037](0037-slack-name-enrichment.md)）は `channel_id` が PK なので channel 名 projection は 1 行に集約される（重複するのは sources/messages のみ）が、reducer の `INSERT ... ON CONFLICT` で `slack_channels.team_id` が最後に観測した alias の team で last-write-wins 上書きされる副作用がある。

## Decision

**global channel ID を dedup キーとし、「共有チャンネルは 1 回だけ取り込む」をツール側で保証する（owner-wins・非破壊）。** channel ID は Slack 全体で一意なので、無関係な別 org 同士でも誤 dedup は起きない（安全なキー）。**externalId 形式は変えない。**

### 1. dedup キー = global channel ID

同一 Grid 内で同一 channel ID を複数 alias が列挙している場合、それらは同一の共有チャンネルである。channel ID を dedup キーとして「1 channel ID あたり 1 回だけ取り込む」を保証する。channel ID は Slack 全体でグローバル一意なため、たまたま別 org が同一 ID を持つことはなく、誤 dedup（silent failure）は起きない。

### 2. owner 選定 — alias 名の辞書順最小（決定性が要件）

owner（当該共有チャンネルを取り込む担当 workspace）は、**再 sync をまたいで安定・決定的**でなければならない。owner が揺れると externalId の owner（team prefix）が変わり、旧 source が orphan 化して再取り込みを誘発するためである。

- **「config 宣言順で最初」は不採用**。`resolveWorkspaces`（`src/connectors/slack.ts`）は `Object.entries(workspaces)` で JS の insertion order を保つが、その順序は `Bun.TOML.parse` が table を宣言順で返すかに依存する。TOML spec 上 table 順序保証はなく、パーサ処理系依存で非決定的になり得る。
- **採用: 共有 channel を列挙する alias 群のうち、alias 名の辞書順で最小のものを owner にする。** 宣言順・パーサに依存せず決定的で、説明可能。
- 将来 `owner=true` 相当の明示指定を足せる余地を残す（明示があればそれを優先し、なければ辞書順最小へフォールバック）。

owner を選定したら、skip した alias とともに info/warn を集約出力する（例: `channel C123 shared across [bp, employees] → ingesting under 'bp'`）。cursor は owner のみが持つ。

### 3. 3 層で対処する

- **Layer 1 — sync 時の owner-wins dedup（中核・非破壊）**: sync 前に「channel ID → owner alias」の割り当てを計算し、同一 channel ID が複数 alias に現れたら owner の 1 workspace でのみ `toRecord` する。非 owner alias の当該 channel は skip し、共有チャンネルを集約 warn する。cursor は owner のみが保持する。externalId 形式は不変なので、単一 workspace 設定・非共有チャンネルには一切影響しない。
- **Layer 2 — discovery の dedup / マーキング（重複設定の予防）**: `slack conversations` の org-level auto-enumerate merge を channel ID で dedup（or「shared across: employees, bp」とマーク）する。config block 生成（`renderWorkspacesConfigBlock`）で共有チャンネルは owner block にだけ出力し、他 block にはコメントで「shared, owned by `<alias>`」を付す。`--json` に `sharedAcross: string[]` を追加する。workspace-level token を 1 workspace ずつ実行するケースは 1 invocation で横断を見られないため、Layer 3 で補完する（非対称は許容）。
- **Layer 3 — config 検証 / doctor 警告（早期検出）**: config 読込 / `slack sync` 前 / `doctor` で、同一 channel ID が複数 alias に列挙されていないか検査し、owner と skip 対象を warn する（sync を回さずとも気付ける）。Layer 1 の owner 選定ヘルパを共有する。

### 4. `slack_channels.team_id` の last-write-wins flip は Layer 1 で収束（既知事項）

複数 alias で同一 channel を観測すると `slack_channels.team_id` が最後の観測で上書きされ、team_id が flip する副作用がある（reducer の upsert / last-write-wins。[ADR-0037](0037-slack-name-enrichment.md)）。Layer 1 導入後は当該 channel が owner でのみ観測されるため team_id が安定する（副次的改善）。修正前に既に flip している環境は projection rebuild で owner 基準に収束する。

### 5. スコープ — messages（team prefix 付き externalId）に限定

- **lists は対象外**。list item の externalId は `slack:list:<listId>:item:<id>`（`src/connectors/slack.ts`）で **team prefix を持たない**ため、同一 list を複数 alias に設定しても同一 externalId に collapse し、既に自然 dedup される（冪等・重複しない）。
- 対象は **同一 Grid 内の multi-workspace 共有チャンネルの messages**（同一 global channel ID・team prefix 付き externalId）に限定する。

### 6. Slack Connect（外部 org 共有）は対象外

dedup は **「channel ID がグローバル一意」を前提**とする。この前提は同一 Grid 内では成立するが、Slack Connect（外部 org との共有）では外部 org 間で崩れ得るため、誤 dedup（silent failure）のリスクがある。したがって **dedup は同一 Grid 内前提**である旨を code コメント + docs に明示し、前提が崩れる状況（Slack Connect）は将来課題とする。

### 7. externalId の canonical 化（team prefix 除去）は見送り

恒久解は externalId を team 非依存化する（`slack:<channel>:<ts>` へ canonical 化する）ことである。これにより owner 概念そのものが不要になり、owner 付け替え時の再取り込みも消える。しかし本 ADR では **見送る**。

理由: **[ADR-0036](0036-task-external-home.md) の task read-back が `sources.external_id` を join キーに使う**（`src/projections/task-readback.ts` の `JOIN sources s ON s.external_id = t.published_external_id`）。externalId を変えると published task の join が壊れるため破壊的で、migration が必須になる。Layer 1 で実害（重複取り込み）は解消するため、canonical 化は本 ADR では採らず follow-up に切り出す。

**既知の制限**: Layer 1 は externalId を team で名前空間化したまま残す。owner を後で付け替えると team prefix が変わり externalId が変化し、旧 source が orphan 化して再取り込みが起きる。owner 選定を決定的（決定 2）にすることでこの揺れを最小化するが、config を手で編集して owner が変わった場合は再取り込みが発生する（既知事項）。

## Consequences

### Positive

- 同一 Grid の共有チャンネルを複数 alias に設定しても、`slack sync` 後の source が channel ID 単位で 1 系統になり、`slack.demand.list` / `search` / `brief` / `personal-brief` の重複ヒットが消える。triage の信頼性が上がる。
- owner を alias 名の辞書順最小で選ぶため、TOML パーサ順序に依存せず決定的で、再 sync をまたいで安定する（externalId の owner が揺れない）。
- externalId 形式を変えないため非破壊。単一 workspace 設定・非共有チャンネル・既存 source・[ADR-0036](0036-task-external-home.md) の task read-back join に一切影響しない。migration 不要。
- `slack_channels.team_id` の last-write-wins flip が owner のみ観測へ収束し安定する（副次的改善）。
- 3 層（sync / discovery / config・doctor）で多重に防御し、ユーザーが重複設定しても sync 時に吸収され、設定段階でも warn で気付ける。

### Negative / Trade-offs

- owner 付け替え時の再取り込み（決定 7）が残る。externalId を team で名前空間化したままなので、config 編集で owner が変わると旧 source が orphan 化する。恒久解（canonical 化）は follow-up。
- owner の token が当該共有チャンネルに到達不能な場合、owner での取り込みが失敗する。v1 は「owner の token がアクセス可能であること」を前提とし、既存の unreachable 集約 warn（[ADR-0011](0011-slack-operational-verbs-and-readiness.md)）で surface して reassign を促す（プローブによる自動 owner 切替は将来課題）。
- 修正前に既に二重取り込み済みの環境には、古い重複 source が残る。非 owner 側の重複 source は externalId prefix `slack:<non-owner-team>:<shared-channel>:*` で識別でき、[ADR-0026](0026-source-forgetting.md) の `source.forget` + projection rebuild で cleanup できる（PR4 でガイド化）。
- dedup が同一 Grid 前提であるため、Slack Connect（決定 6）は対象外で、外部 org 共有チャンネルは引き続き二重化し得る（将来課題）。

## Alternatives Considered

- **(a) externalId の canonical 化（team prefix 除去 → `slack:<channel>:<ts>`）** — 見送り（決定 7）。恒久解だが [ADR-0036](0036-task-external-home.md) の task read-back が `sources.external_id` を join キーに使うため破壊的で migration が必須。Layer 1 で実害が消えるため本 ADR では採らず follow-up に切り出す。
- **(b) owner を config 宣言順で選ぶ** — 却下（決定 2）。`Bun.TOML.parse` の table 順序保証が TOML spec 上なく処理系依存のため、owner が非決定化し得る。owner が揺れると externalId の owner が変わり再取り込みを誘発する。alias 名の辞書順最小の方がパーサ非依存で決定的。
- **(c) 重複をエラーにしてユーザーに一意化を強制する** — 却下。`slack conversations` は各 workspace で共有チャンネルを出すためユーザーが両方に貼りがちで、エラーにすると UX が劣化する。ツールが channel ID のグローバル一意性を知っている以上、重複はツール側で吸収すべき（owner-wins）で、ユーザーに手作業の一意化を強制しない。
