# 0040. Proactive push lane（cron one-shot digest + standing consent）

- Status: Proposed
- Date: 2026-07-06
- Deciders: Suasor maintainers
- Related: [ADR-0003](0003-local-first-and-content-minimization.md)（egress 最小化）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（HITL）, [ADR-0017](0017-brief-period-bundle.md)（brief bundle）, [ADR-0025](0025-local-draft-export.md)（ローカル出力の先例）, [ADR-0027](0027-bulk-sync-orchestration.md)（scheduling は OS scheduler へ委譲）, [ADR-0036](0036-task-external-home.md)（「行動する場所・タイミングで目に入ること」の価値論理・actuator 経路）, [ADR-0041](0041-neutral-demand-priority-substrate.md)（digest の内容源）
- Tracks: #412

## Context

製品境界「**No always-on proactive agent** — no daemon / no unsolicited notifications」は、`docs/requirements/scope.md` で「**初期は**人/エージェント起点」とヘッジされたまま、ADR 0000〜0039 のどこでも再訪されていない。

一方 [ADR-0036](0036-task-external-home.md) は「**タスクを捕捉する目的は『行動する場所・タイミングで目に入ること』**。Suasor 専用サイロに置くと忘れられやすい」という価値論理で外部ホームへの egress write を導入した。この論理はタスクに固有ではない — brief・overdue・commitment 期限（[ADR-0021](0021-commitment-ledger.md)）・未処理 demand にそのまま適用される。しかし advise 層の出力は今日、**ユーザーが chat セッションを開いて skill を起動したときにしか**表面化しない。overdue タスクも期限切れの約束も、尋ねられるまで SQLite の中で沈黙する。

つまり ADR-0036 がタスクについて解いた「サイロで忘れられる」問題が、**advise 層全体に未解決のまま残っている**。肩を叩けない秘書は「advises」の中核約束を果たせない。これは pull-only 境界の自己矛盾であり、境界の再設計（または明示的な再確認）を要する。

## Decision

**daemon は導入しない（不変）。push は「ユーザーが事前構成した名前付き recurring job」からの cron 起動 one-shot に限定して導入する。**

1. **実行モデル = cron one-shot（[ADR-0027](0027-bulk-sync-orchestration.md) と同型）** — 常駐プロセス・watcher は作らない。OS scheduler（cron / launchd / systemd）が `suasor digest`（仮）を起動し、1 回分の digest を組み立てて出力し、終了する。scheduling の委譲先・インストール導線は ADR-0027 の機構を再利用する。
2. **consent class「standing consent（定常同意）」を新設** — ユーザーが**名前付き recurring job**（何を・どのチャネルへ・どの頻度で）を config で事前構成する行為を承認とみなし、per-event の HITL 承認は要求しない。構成されていない出力は一切行わない（= unsolicited notification の禁止は維持。変わるのは「同意の粒度」であり「同意なしに送らない」原則ではない）。[ADR-0004](0004-mcp-agent-boundary-and-hitl.md) の per-event HITL は write 系 tool に対して不変。
3. **チャネルは additive に構成** — 初期候補: (a) OS notification、(b) ローカルファイル出力（[ADR-0025](0025-local-draft-export.md) の sandbox 規律に従う）、(c) [ADR-0036](0036-task-external-home.md) の actuator 経路を使った Slack DM-to-self。egress を伴うチャネル（c）は actuator と同じ secret / scope / 構造化エラー規律に従う。
4. **digest の内容** — 既定は [ADR-0041](0041-neutral-demand-priority-substrate.md) の priority 上位 N + overdue + 期限接近 commitment + brief warnings（データ鮮度等）。config で節を構成可能。要約文の生成はしない（[ADR-0017](0017-brief-period-bundle.md) と同じく bundle・render に徹し、ML 委譲 [ADR-0006](0006-ml-delegation.md) を維持）。
5. **境界文言の正直化** — `docs/requirements/scope.md` の「初期は人起点」ヘッジを解消し、README の境界を「no daemon / **事前同意のない**通知なし」へ改める（本 ADR Accepted 後の follow-up）。

## Consequences

### Positive

- advise 層の「サイロで忘れられる」問題（ADR-0036 が自ら指摘した failure mode）が brief / overdue / commitment / demand にも解消される
- no-daemon の簡潔さ・local-first の運用モデル（[ADR-0027](0027-bulk-sync-orchestration.md)）を維持したまま proactive 価値を得る
- 「同意なしに送らない」原則を、per-event HITL と standing consent の 2 クラスに**明文化**することで、境界が正直になる

### Negative / Trade-offs

- consent モデルが 2 クラスになり、説明・ドキュメントの複雑度が上がる（write tool = per-event HITL / digest = standing consent の区別を明記する必要）
- チャネルごとの実装・失敗モード（OS notification の可搬性、egress チャネルの認証・rate limit）を抱える
- cron 依存のため、scheduler が壊れると digest も止まる（sync freshness と同じ staleness 問題。doctor / brief への鮮度露出は別 finding の follow-up と併走）

## Alternatives Considered

- **pull-only を恒久方針として再確認** — 却下。「proactivity は外部 home が担う（GitHub/Jira が notify する）」は published task にしか成立せず、brief・commitment・ローカルタスク・demand はカバーされない。ヘッジを外して固定するには穴が大きすぎる
- **常駐 daemon / イベント駆動の即時通知** — 却下。local-first・no-daemon の簡潔さを失う大転換であり、digest の粒度（日次/時間毎）に即時性は不要。cron one-shot で価値の大半を得られる
- **digest を書かず外部 home への publish を広げる（commitment 等も外部化）** — 却下。外部化は「管理対象」に適するが、「今日の状況の要約」はどのツールにも自然な住処がない。補完関係であり代替ではない
