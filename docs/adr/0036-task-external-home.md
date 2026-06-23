# 0036. タスクの外部ホーム管理（egress write-back / single-pane）

- Status: Accepted
- Date: 2026-06-22
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event-sourced / replay-stable）, [ADR-0003](0003-local-first-and-content-minimization.md)（local-first / egress 最小化・送信は HITL）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP+HITL write）, [ADR-0007](0007-connector-contract.md)（connector 契約＝read 専用）, [ADR-0008](0008-assistant-skills.md)（assistant skills）, [ADR-0009](0009-multi-agent-neutrality.md)（write tool は全 host 共通 MCP surface）, [ADR-0021](0021-commitment-ledger.md)（commitment `dueDate`）, [ADR-0025](0025-local-draft-export.md)（local export＝egress を local file に限定。SaaS 直接 write は「別途慎重な ADR が要る」と明記）, [ADR-0028](0028-task-scheduling-fields.md)（task `dueDate` / `priority`）, [ADR-0031](0031-mcp-structured-errors.md)（MCP 構造化エラー）
- Tracks: #311（GitHub Issues actuator + 基盤先行。Jira / Slack actuator・読み戻し D4・task.update 統一・generate skip は後続）

## Context

Suasor の自前タスク（`task.create` / `propose.apply` で `tasks` projection に入る）は、**Suasor の中にしか住めない**。一方ユーザーが実際に作業する場所は GitHub / Jira / Slack 等であり、そこに取り込んだ Issue/ticket は **source として観測できる（検索可能）が、管理可能なタスクにはなっていない**（観測 ≠ 管理。`tasks` に入るのは `TaskProposed` / `TaskApplied` 経由のみ、`src/projections/reducer.ts`）。

核心の問題は **プロダクト価値**にある:

- **Suasor 内に閉じたタスクは忘れられやすい** — タスクを捕捉する目的は「行動する場所・タイミングで目に入ること」。なのに Suasor 専用サイロに置くと、ユーザーが日々生活する GitHub/Jira/Slack から隔離され、「取りこぼさない」という中核価値を自ら損ねる。
- **「もう一個の Todo アプリ」は採用障壁** — 人は使い慣れたタスクツールを捨てない。Suasor 固有の価値は横断捕捉 + AI 提案 + 優先付け（どの単独ツールにもできない）であり、タスクの**住処**そのものではない。

したがって Suasor は **「頭脳（横断捕捉・AI 提案・優先付け・由来）」に徹し、確定タスクの住処は外部ツールに委ねる**（案B）。これは [ADR-0025](0025-local-draft-export.md) が「SaaS へ直接作成・送信は本 ADR スコープ外、別途慎重な ADR が要る」と先送りした **SaaS への egress write** をついに導入するものであり、本 ADR でその境界を明文化する。

核心の緊張は3つ:

1. [ADR-0007](0007-connector-contract.md) は connector を **read 専用（ソースに書き戻さない）** と定める。本 ADR は外部ツールへの **write（起票・状態操作）** を導入するため、この契約との関係を型レベルで切り分ける必要がある。
2. 「書き出したタスクを次の sync で source として再取り込みする無限ループ」（[ADR-0025](0025-local-draft-export.md) の export-dir / connector-root 重複と同型）を回避する必要がある。
3. egress write は**失敗しうる外部 I/O** であり、[ADR-0025](0025-local-draft-export.md) のローカルファイル write と違って「外部起票成功 → ローカル event append 失敗」が**二重起票**という実害を生む。冪等・順序・認証を決定として詰める必要がある。

> **本文の D ラベル対応**: 議論時の決定番号と本文の通し番号の対応は — D1=決定3（状態正本）, D2=決定1（単一ホーム）, D3=決定7（全外部化）, D4=決定6（読み戻し）。

## Decision

確定タスクを **単一の外部ホーム**に起票し、Suasor は状態の正本を持たず「読む + 操作命令を出す遠隔操作役（single pane）」として振る舞う。connector の read 契約は read 専用のまま不変とし、write は別 capability（actuator）として型レベルで明示分離する。

1. **確定タスクは単一の外部ホームへ起票（egress write）** — 対象は Tier1（GitHub Issues / Jira / Slack List）。ユーザーが設定する**ただ1つの「タスクホーム」**へ起票する。**既定の変更（乗り換え）は可能**だが、**per-task の行き先上書きは初期スコープに含めない**（既定では出さない。概念としては閉じず、将来 additive に「既定ホーム + 任意 override」へ拡張する余地を残す）。プロジェクト/文脈単位のルールも必要時に additive に後付けする。
   - **Tier1 内でも API 成熟度に段差がある**: GitHub Issues / Jira REST は create/update/transition API が成熟。**GitHub と Jira を実装済み**（Jira: `POST /rest/api/3/issue`、complete/reopen は workflow transition＝`doneTransitionId`/`reopenTransitionId` の config 駆動、comment 対応、identity `jira:<host>:<project>:<key>` は read connector と一致、冪等は label `suasor`+`suasor-task-<id>`）。**Slack Lists の write API は spike で GA 確認済み**（`slackLists.items.create`/`.update`/`.list`、scope `lists:write`、有料プラン限定）＝Tier1 維持、actuator は後続実装。
   - **GitHub Projects v2 は `github` home のオプションとして統合（#316。当初 #314 で別 destination `github_projects`＝draft issue として実装したが撤回）**: GitHub の実態は **Projects v2 = Issues の上のビュー / Status レイヤー**であり、現場フローは「**本物の Issue を board に載せて Status を動かす**」。draft issue は二級市民（担当・コメント・`#`参照が弱い）で主要ユースケースを満たさない。よって `github` home に**任意**の Projects v2 board（`project` = PVT node id）を持たせ、`publish` は本物の Issue 作成 + board へ add（`addProjectV2ItemById`、Issue の node id）、`complete` / `reopen` は Issue state 更新 + **board Status 更新**（`updateProjectV2ItemFieldValue`。field / option の node id は project 固有＝**config 駆動**、Jira と同型。未設定なら Issue state のみ）。identity は **Issue のまま**（`gh:owner/repo:issue:N`）。`comment` は本物の Issue なので対応。draft-issue 専用の独立 destination は設けない。

2. **connector の「read（ingest）」と「actuator（write/act）」を型レベルで分離** — [ADR-0007](0007-connector-contract.md) の read 契約（`Connector` interface: read 専用・差分取得・本文保持）は**一切変えない**。本 ADR が足すのは、それとは別 interface の **`Actuator`**（例 `publish(task) → externalId` / `transition(externalId, state)` / `comment(externalId, body)`、`src/connectors/actuator.ts`）。connector(read) と actuator(write) は**独立レジストリ**で、1 ソースは read-only もしくは read + actuator のいずれかを実装する。read connector しか持たないソースは従来どおり read 専用のまま。actuator は HITL（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md)、`readOnlyHint: false`、auto-apply なし）。
   - **multi-agent 中立** — actuator は host 固有ツール（例 Claude Code の GitHub 連携）に依存せず、**全 host 共通の MCP write surface** として提供する（[ADR-0009](0009-multi-agent-neutrality.md)）。これにより Codex / Gemini / Copilot からも同一手段で起票・状態操作でき、[ADR-0025](0025-local-draft-export.md) の `draft.export` と同じ中立性の正当化を踏襲する。
   - **本 ADR は [ADR-0003](0003-local-first-and-content-minimization.md) §3 の egress 境界を初めて拡張する。** ただし §2（connector = read 専用）は不変（actuator は connector ではない別 capability）であることを 0003 側にも追補する。

3. **状態の正本＝ホームツール1つ（D1）** — タスク状態の持ち主は外部ツール**ただ1つ**。Suasor はそれを **読む** + **操作命令を出して変える**（complete / reopen / comment）。`tasks` projection は**正本ではなく、優先ビュー表示用の読み取りキャッシュ + 由来(provenance)**として残す。状態の**正本**が外部1つなので、双方向同期の last-write-wins 曖昧性を構造的に避けられる。
   - **整合規律（競合の最小化）** — Suasor 側にも read キャッシュと operate 経路があるため、「ローカルだけ先に状態を変える」経路があると読み戻しと競合しうる。よって既存の `task.update`（[ADR-0028](0028-task-scheduling-fields.md)）は、公開済みタスクに対しては**外部へ操作命令を出す経路（actuator）に統一**し、ローカル状態だけを先行変更する経路を塞ぐ。

4. **egress write tool 群（HITL・body-less 監査 event・冪等）** — 新 write tool `task.publish`（起票）/ `task.act`（complete/reopen/comment 等の状態操作）を導入する（[ADR-0009](0009-multi-agent-neutrality.md) の MCP surface・`openWorldHint: true`）。
   - **監査は body-less event**（[ADR-0025](0025-local-draft-export.md) 先例）: `TaskPublished { taskId, destination, externalId, publishedAt }` / 状態操作の監査 event（例 `TaskActionIssued { taskId, externalId, action, issuedAt }`）。本文は event に焼かない。
   - **schemaVersion** — これらは `DomainEvent` discriminated union への**新 type の additive 追加**であり `schemaVersion=1` 据え置き（既存 payload は不変、[ADR-0002](0002-event-sourced-architecture.md) upcast 不要）。読み戻し（決定6）は既存 `TaskApplied` を再利用するため新 event を要しない。
   - **冪等キー** — `taskId`（title + provenance 由来・決定論的）を起票リクエストの **client-side idempotency key** として外部 API に渡す。idempotency ヘッダ非対応ツール（Jira 等）では「起票前に marker（`taskId`）で検索 → 既存があれば再利用」を actuator 規約とする。これにより**起票 RPC のタイムアウト/リトライでも二重起票しない**。
   - **順序と失敗時挙動** — まず外部 write → 成功時のみ監査 event を append。ただし「外部起票成功 → event append 失敗」は [ADR-0025](0025-local-draft-export.md) の orphan ファイルと違い**二重起票という実害**を生む。これを冪等キー（上記）で吸収する（次回 apply は外部側 dedup / marker 検索で既存を再利用し、externalId を改めて記録する）。
   - **認証スコープ** — actuator は read connector と**別スコープ（write）のトークン**を要する（GitHub `issues:write`、Jira create/transition、Slack `lists:write` 等）。secret は `secret(name)` で別名管理し、起票前に scope 不足を構造化エラー（下記）で fail させる。

5. **失敗は構造化エラーで返す（[ADR-0031](0031-mcp-structured-errors.md)）** — actuator が導入する新たな失敗モード（外部 write 失敗・scope 不足・rate limit・ホーム未設定）は 0031 の構造化エラーで返す。新 code（例 `ACTUATOR_NOT_CONFIGURED` / `EGRESS_FAILED` / `PUBLISH_DESTINATION_INVALID`）を `src/mcp/errors.ts` に追加し、`docs/design/mcp-surface.md` を更新する。`[tasks]` ホーム未設定は `draft.export` の `[export].dir` 未設定と同様、**起動時致命にせず per-call で degrade**（該当 tool 呼び出し時にのみエラー）。

6. **状態読み戻し — 完了状態 + 期日・優先度（D4）** — 公開済みタスク（外部 id リンク有り）に限り、既存の connector sync で取り込んだ source の状態から **完了/未完了 + `dueDate` / `priority`** を読み、native task に `TaskApplied` を append して優先ビューを正確に保つ。**読み取り → ローカル event のみ。ツールには書かない**（操作命令＝決定4 とは別経路）ので**ループしない**。同一状態は no-op（[ADR-0028](0028-task-scheduling-fields.md) / reducer 既存挙動）。状態マッピング例:
   - GitHub: open→open/in_progress、closed→completed、closed(not planned)→dropped
   - Jira: To Do→open、In Progress→in_progress、Done→completed、Won't Do→dropped（**カスタムワークフローは site 依存。category ベースでマップし未知 status は保守的に現状維持**）
   - Slack List: チェック→completed

7. **全タスクを外部化、Suasor 自身はホームにしない（D3）** — 確定タスクは必ず外部ホームに住む。Suasor の自前面は **triage inbox（コミット前の提案承認）だけ**に保ち、タスク管理用の独自 UI（案A）は作らない（サイロ化・忘却リスクの回避）。**private なタスクはホームの選び方**（自分専用 Slack List / private repo / Google Tasks 等）で対応する。

8. **無限ループ回避** — 「書き出したタスクを source として再取り込みし、再提案・二重計上する」ループを次で防ぐ（[ADR-0025](0025-local-draft-export.md) のディレクトリ包含隔離を一般化した原則:**出力先と読み取りスコープを必ず突き合わせ、出力を新規入力として再消費しない**）:
   - **同一性リンク** — 起票時に外部 id を provenance 記録（決定4）。「この外部項目＝自分のタスク」を Suasor が知っている状態にする。
   - **マーカー（保険）** — 外部項目に識別子を刻む（GitHub/Jira は label `suasor` + body の taskId 等）。`projections rebuild` で local の id-map が失われても再認識できる。
   - **rebuild window の保護** — `projections rebuild` 後は marker から id-map を**読み戻し・再提案より前に**再構築する。再構築完了まで該当 source の起票・読み戻しを保留し、rebuild 直後の window での二重起票/取りこぼしを防ぐ。
   - **読み側 dedup/skip** — connector は項目を source として mirror してよい（検索用）が、提案・抽出パイプラインは**公開済みタスクに紐づく source をスキップ**（自分のタスクを再提案しない）。統合ビューは id-map で native task と外部 mirror を**1行に畳む**。
   - **スコープ隔離（可能な所）** — Slack List は**専用 list/channel に書き出し、それを取り込みスコープから除外**できる（最もクリーン）。GitHub/Jira は上記リンク+マーカーで担保。

9. **config** — `[tasks]` に**単一ホーム設定**（destination 種別 + 対象 repo/project/list、Slack 専用 list の取り込み除外フラグ）を持つ。既定の変更は可能。`[tasks].home` と connector 設定の整合を loader で検証する。

## Consequences

### Positive

- 確定タスクがユーザーの**仕事の場所**（GitHub/Jira/Slack）に住み、サイロ化・忘却を解消。モバイル/通知/成熟 UX をそのまま活かせる
- Suasor は「もう一個の Todo アプリ」化を避け、**差別化点（横断捕捉・AI 提案・優先付け）に集中**できる
- 状態の**正本**が外部1つ（D1）なので双方向同期の last-write-wins 曖昧性を構造的に避けられる
- 読み戻しを **read→ローカル event のみ**に閉じ、egress write と分離することで**ループしない**（決定6/8）
- read 契約（[ADR-0007](0007-connector-contract.md)）を不変に保ち、write は別 interface `Actuator` として型分離 — 既存 connector への影響を局所化
- actuator を全 host 共通 MCP surface で提供し multi-agent 中立を維持（[ADR-0009](0009-multi-agent-neutrality.md)）
- body-less 監査 event で content-minimization（[ADR-0003](0003-local-first-and-content-minimization.md)）と「write tool = event を append」規律（[ADR-0002](0002-event-sourced-architecture.md)）を両立

### Negative / Trade-offs

- Suasor が初めて **SaaS への egress write**（送信・書き戻し）を持つ。[ADR-0003](0003-local-first-and-content-minimization.md) §3 境界を拡張するため、auth scope / 失敗時の冪等・順序を慎重に設計する（決定4/5・HITL ゲートで限定）
- ホームツールごとに **actuator アダプタ**（起票・状態操作・状態読み出し・マーカー）が要る。Tier1 でも GitHub 先行、Slack は spike 後（決定1）
- 「single pane で操作」を実現するには decision 4 の write 経路が必須で、read-only の現状より実装面が広い。新たな構造化エラー code・mcp-surface.md 更新の規約コスト（[ADR-0031](0031-mcp-structured-errors.md) Negative）
- 状態読み戻しが完了状態に加え due/priority も対象（D4）— ホームごとの field マッピングが必要で、Jira のカスタムワークフローは site 依存で網羅困難（category ベースで近似）

## Alternatives Considered

- **独自タスク管理 GUI（案A）** — 非推奨。Suasor が「もう一個の見に行く場所」になり、サイロ化・忘却リスクと自前 UI の維持コストを抱える。差別化（横断・AI 提案）に集中できない。
- **外部へ一方向 render のみ（案3:優先リストを Slack/GitHub に出力するだけ）** — 却下。横断マージしたリストを単一ホストツールにきれいに収められず、操作も各ツール任せで single pane にならない。補助的な ambient 出力としてなら将来併用可。
- **双方向同期** — 却下。状態ストアが2つになり衝突解決・last-write-wins の曖昧さ・同期複雑性という、本件で最も避けたいコストを抱える。状態の正本を1つに保つ（D1）方が単純で堅い。
- **per-task / smart routing（タスクごとに行き先自動振り分け）** — **初期スコープ外**。承認のたびに行き先選択を常時出すと摩擦になるため**既定では出さない**。ただし概念としては閉じず、「既定ホーム + 任意 override」「プロジェクト単位ルール」を将来 additive に足す余地は残す。
- **「Suasor に留める」を許容** — 却下。状態の正本を持たない（D1）と矛盾し、最小の管理 UI（案A）が必要になりサイロ/忘却リスクが戻る。private はホームの選び方で対応する。
- **read 専用のまま据え置き（現状）** — 非推奨。タスクが Suasor 内に隔離され忘れられやすく、中核価値「取りこぼさない」を損ねる。
