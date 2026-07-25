# 0041. Connector 中立の demand / 優先度基盤（`demand.list` + seen-state + deterministic scorer）

- Status: Accepted（2026-07-06 承認）
- Date: 2026-07-06
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（seen-state は event）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（write は HITL）, [ADR-0006](0006-ml-delegation.md)（決定論的算術は委譲対象外＝プロダクトコードに置いてよい）, [ADR-0012](0012-slack-demand-digest.md)（本 ADR が決定 3 / 4 を supersede）, [ADR-0021](0021-commitment-ledger.md)（commitment 期限）, [ADR-0028](0028-task-scheduling-fields.md)（dueDate / priority / overdue 派生）, [ADR-0036](0036-task-external-home.md)（差別化宣言「横断捕捉 + AI 提案 + 優先付け」）, [ADR-0040](0040-proactive-push-lane.md)（digest の内容源として消費）
- Tracks: #412（決定）/ [#419](https://github.com/ozzy-labs/suasor/issues/419)（実装）

> **Extended by [ADR-0043](0043-email-demand-signals.md)（2026-07-25）:** 決定 1 の導出面に email demand
> （自分宛て未返信スレッド）を追加し、決定 3 の順序基線に `aging_demand` tier を
> `overdue` と un-acked demand の間へ挿入した。中立基質の構造自体は不変。
>
> **Extended by [ADR-0044](0044-calendar-proximity-signals.md)（2026-07-25）:** 導出面に calendar
> proximity（`meeting_soon` / `meeting_prep`）を追加し、順序基線の最上位に `starting_soon`
> （overdue より上 — 予定だけが時刻を動かせない）、`aging_demand` の下に `meeting_prep` を置いた。
> 更新後の基線: `starting_soon > overdue > aging_demand > meeting_prep > un-acked demand > due_soon > priority > recency`。
>
> **決定 3 の順序基線は [ADR-0045](0045-priority-ranking-model.md)（2026-07-25）が supersede した:**
> tier ラダー（辞書式）から「hard tier 1 つ + 重み付きスコア」へ移行し、程度の比較を可能にした。
> 決定 1（中立 demand 導出）/ 決定 2（seen-state）/ 決定 4（digest の内容源）は不変。

## Context

[ADR-0036](0036-task-external-home.md) は Suasor の差別化を「**横断捕捉 + AI 提案 + 優先付け**（どの単独ツールにもできない）」と宣言する。しかし adversarial review で、**優先付けはプロダクトコードに存在しない**ことが確定した:

1. **demand が Slack 専用** — attention 信号の tool は `slack.demand.list` のみ。GitHub connector は自身のコード注釈で notifications を「a demand signal (mentions / review requests / etc.)」と呼びながら、`github_notification` はどの tool / skill にも surface されない（full-text 検索のみ）。Gmail / Outlook も同様で、email の「自分宛て未応答」信号は存在しない。
2. **「未処理」が偽り** — [ADR-0012](0012-slack-demand-digest.md) 決定 4 が host 側に委譲した seen-marker は、どの host / skill にも実装されなかった。結果、取り込まれた全 mention / DM が永遠に「未処理」として `next-actions` の優先度関数で dueDate / priority より上位に居座る（Slack を Slack で処理する通常ユーザーにとって、この tier は既処理項目の山になる）。
3. **優先度関数が散文** — 「overdue > slack.demand > dueDate 近接 > priority > 更新新しさ」は `docs/skills/next-actions/SKILL.md` の手順書にのみ存在し、コードに comparator もテストもない。ranking は host / 実行ごとに揺れ、skill ファイルの編集で無音に drift する。[ADR-0028](0028-task-scheduling-fields.md) は「skill 側の優先度関数が安定するように」と priority enum を導入したが、その関数に住処を与えなかった。

これらはすべて**決定論的な算術**であり、[ADR-0006](0006-ml-delegation.md)（ML 委譲）は禁止していない。「gather 側は event-sourcing と型とテストで厳密、advise 側は散文」という非対称が、宣言した差別化を実体のないものにしている。

## Decision

**ソース中立の demand 導出・store 側 seen-state・read 層の決定論的 scorer を、プロダクトコード（projection + MCP tool）として実装する。ranking の基線はコードが持ち、会話文脈による上書きだけを host LLM に残す。**

1. **中立 demand 導出 + `demand.list`（read tool）** — demand 行の導出を connector 中立に一般化する: (a) `slack_message` の mention / DM（[ADR-0012](0012-slack-demand-digest.md) の既存述語を fold、`source_type=slack`）、(b) `github_notification`（取り込み済みの `reason` / `unread` メタで demand 種別と状態を判定）。将来の email demand（自分宛て未応答スレッド）も同じ導出面に載せる。`slack.demand.list` は `demand.list` に**置換**する（破壊的変更可。ADR-0012 決定 3 を supersede）。導出は既存 ingest からの query / projection であり、追加 fetch は行わない（ADR-0012 決定 1 の原則を中立化して継承）。
2. **seen-state（`demand.ack` / `demand.dismiss`）** — 「未処理」を真実にする durable な状態を導入する。`demand.ack`（対応した）/ `demand.dismiss`（対応不要）は source external_id をキーに seen event を append する **HITL write tool**（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md)、他の write と同型）。`demand.list` は既定で un-acked のみを返す（`include_seen` で全件）。ADR-0012 決定 4（host 側 seen-marker）を supersede する — 状態の置き場は host の記憶ではなく event ログ（[ADR-0002](0002-event-sourced-architecture.md)）。connector が状態を持たない原則は不変。
3. **決定論的 scorer（read 層・cross-entity）** — tasks + open commitments + un-acked demand を 1 本のランク付きリストに合成する read query を実装し、**テストで固定**する。順序の基線: overdue（task / commitment）> un-acked demand（鮮度順）> dueDate 近接 > priority > 更新新しさ。出力はランク済みリスト + 各行のスコア根拠（どの規則で上に来たか）。`next-actions` / `personal-brief` skill はこの基線を消費する形に改訂し、**skill prose 単独での順位決定を廃止**する。会話文脈による上書き（「今日は Slack は無視して」等）は host LLM の裁量として残す。重みの調整は今後の tuning 対象だが、同一入力に対する順序はコードが保証する。
4. **[ADR-0040](0040-proactive-push-lane.md) の内容源** — digest の既定内容はこの scorer の上位 N を用いる。

## Consequences

### Positive

- 宣言済みの差別化「優先付け」が、host 非依存・再現可能・テスト可能な実装を持つ
- GitHub / email 中心のユーザーが Slack ユーザーと同等の triage を得る（demand の signal parity）
- 「未処理」が実態と一致し、demand tier が dueDate より恒久的に上に居座る逆転が解消する
- [ADR-0006](0006-ml-delegation.md) と整合（算術のみ。LLM 推論は引き続き host）

### Negative / Trade-offs

- `slack.demand.list` の破壊的置換（skill / host 側の参照更新が必要。ADR-0012 決定 5 で広げた skill 記述も改訂対象）
- demand projection / seen event / 新 write tool 2 本の追加面（tool カタログはさらに増える — 表面積の縮約は別 finding の課題として認識した上で、ここは差別化の中核なので優先する）
- scorer の重み・規則は初期値であり、実利用でのチューニングが要る（ただし「揺れない基線がある」こと自体が現状からの改善）

## Alternatives Considered

- **skill prose の精緻化のみ（現状維持）** — 却下。非再現・host 依存・テスト不能のまま。宣言した差別化が「32 本の markdown と host の即興」で終わる
- **ML / embedding による ranking** — 却下。[ADR-0006](0006-ml-delegation.md) に抵触する上、必要ですらない（規則ベースで十分に説明可能・予測可能。説明可能性は secretary の信頼に直結）
- **demand を inbox lifecycle に fold（mention を自動で inbox item 化）** — 却下。inbox は人が curate する triage 面であり、自動由来で大量に湧く demand と意味論が異なる。demand は導出 + seen-state の軽量モデルが適する
- **seen-marker を引き続き host 委譲（ADR-0012 決定 4 維持）** — 却下。2 週間の実運用で どの host にも実装されず、実装されない構造（host ごとに N 回作る・永続場所がない）自体が原因。store 側 1 箇所が正しい置き場
