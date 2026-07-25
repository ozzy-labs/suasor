# 0045. 優先度ランキングモデル（hard tier + 重み付きスコア）

- Status: Accepted（2026-07-25 承認）
- Date: 2026-07-25
- Deciders: Suasor maintainers
- Related: [ADR-0041](0041-neutral-demand-priority-substrate.md)（本 ADR が決定 3 の順序基線を supersede）, [ADR-0043](0043-email-demand-signals.md)（`aging_demand` tier を項へ移す）, [ADR-0044](0044-calendar-proximity-signals.md)（`starting_soon` / `meeting_prep` を再定義）, [ADR-0028](0028-task-scheduling-fields.md)（時刻依存状態は read 時派生・`now` 注入）, [ADR-0006](0006-ml-delegation.md)（決定論的算術は委譲対象外）, [ADR-0040](0040-proactive-push-lane.md)（digest の内容源）
- Tracks: [#448](https://github.com/ozzy-labs/suasor/issues/448)（決定）

## Context

[ADR-0041](0041-neutral-demand-priority-substrate.md) 決定 3 は、順序の基線を **tier ラダー（辞書式）** として実装した。その後 [ADR-0043](0043-email-demand-signals.md) が `aging_demand` を、[ADR-0044](0044-calendar-proximity-signals.md) が `starting_soon` / `meeting_prep` を挿入し、ラダーは **7 段**になった:

```text
starting_soon > overdue > aging_demand > meeting_prep > un-acked demand > due_soon > priority > recency
```

辞書式順序は「上位 tier が下位を**無条件で**上回る」ため、**程度を比較できない**。これは理論上の懸念ではなく、現行実装で実際に起きる:

> `starting_soon` は「開始 120 分以内」なので、**110 分後に始まる会議**が **3 週間放置している期限超過タスク**より上に出る。

110 分あれば期限超過タスクは片付く。「予定は動かせない」という `starting_soon` の根拠は開始 15 分前には正しく、110 分前には正しくない。tier は「120 分以内か否か」の 2 値しか表現できず、この差を扱えない。

同じ構造的欠陥が他の tier にもある — 「1 日超過」と「3 週間超過」が `overdue` tier 内で同格に扱われ、期日の近さでしか区別されない。

[ADR-0044](0044-calendar-proximity-signals.md) の Consequences は「これ以上の追加は tier ラダーではなく重み付きスコアへのモデル変更を検討すべき閾値」と自ら記した。**その閾値には既に到達している**。加えて、signal を 1 つ足すたびに tier が 1 段増える構造は、[#448](https://github.com/ozzy-labs/suasor/issues/448)（表面積の収縮）と正面から衝突する。

## Decision

**「本当に動かせない壁時計」だけを hard tier として残し、それ以外はすべて 1 本の重み付きスコアで比較する。重みはコード内の定数とし、各行は「なぜ上に来たか」を主要因 1 文で説明する。**

### 決定 1: hard tier は 1 つだけ — 開始 30 分以内の会議

順序が絶対に固定される tier は **`starting_soon`（開始 30 分以内の `meeting_soon`）のみ**とし、[ADR-0044](0044-calendar-proximity-signals.md) 決定 4 の窓を **120 分 → 30 分**に狭める。tier 内は `start` の昇順。

30 分という値の根拠は「**その時間で他の何かを終わらせる余地がない**」こと。110 分後の会議はスコア側で期限超過タスクと比較されるべきで、15 分後の会議はどんなスコアより上に出るべき。hard tier は「壁時計に対して固い」ことが**他のすべての考慮を無効化する**領域だけに限る。

**`overdue` は hard tier ではなくなる**（決定 2 の項に降りる）。期限超過は「もう破っている」状態であって、「これから物理的に不可能になる」状態ではない。

### 決定 2: 残りはすべて 1 本のスコア

hard tier に入らない候補（task / commitment / demand / meeting_prep）を、単一のスコア関数で比較する:

```text
score = w_overdue  × overdue_days
      + w_aging    × unanswered_days      (email demand `to` — 古いほど高い)
      + w_fresh    × demand_freshness     (slack / github demand — 新しいほど高い)
      + w_due      × due_proximity        (期日が近いほど高い)
      + w_prep     × prep_urgency         (会議開始が近いほど高い・24h 窓)
      + w_priority × priority_rank        (high / normal / low)
```

**符号が逆の 2 つの時間項を明示的に分ける**のが要点。mention は古くなるほど陳腐化するが（`demand_freshness`）、未返信メールは古いほど深刻になる（`unanswered_days`、[ADR-0043](0043-email-demand-signals.md)）。tier ではこれを「新しい順の tier」と「古い順の tier」に分けるしかなかったが、スコアなら**逆符号の 2 項**として自然に共存する。

各項は**上限で飽和させる**（例: `overdue_days` は 30 日で頭打ち）。飽和がないと、1 年放置された 1 件が他のすべてを永久に押し下げる。

`now` は注入可能（read 時派生・[ADR-0028](0028-task-scheduling-fields.md) と同型。projection には焼かない）。

### 決定 3: 重みはコード内の定数（設定にしない）

`w_*` は `src/mcp/queries.ts` 側の定数とし、**config で上書きできるようにしない**。

理由: ① 全ユーザーで同一の挙動になり、同一入力に対する順序をテストで完全に固定できる（[ADR-0041](0041-neutral-demand-priority-substrate.md) が既に取っている立場の継承）、② 「順序がおかしい」の報告を**その人の設定を再現せずに**調べられる、③ 現実にはほとんどの利用者は設定を触らないため、可変にしても価値は少数にしか届かない。

硬直の逃げ道は既にある — **会話文脈での上書き**（「今日は Slack は無視して」）は host LLM の裁量として残る（[ADR-0041](0041-neutral-demand-priority-substrate.md) 決定 3）。重みの改善は「実利用の観察 → 全員に効く調整」という 1 本の経路に集約する。

### 決定 4: 説明は「スコア値」ではなく「主要因」

スコアモデルの最大の代償は説明可能性の劣化（*「なぜ上？」→「スコア 7.3 だから」*）である。これを避けるため、各行は引き続き `reason` + `explanation` を返すが、その意味を変える:

- **`reason`** = そのスコアに**最も寄与した項**（`overdue` / `aging` / `demand` / `due_soon` / `prep` / `priority`）
- **`explanation`** = その項を人間の言葉にした 1 文（例: 「期限を 21 日超過」「2 時間後の会議・議題あり」）

スコア値そのものは返すが、**表示の主役にはしない**。ユーザーが受け取るのは「なぜこれが今なのか」であって数値ではない。

### 決定 5: 新しい signal は tier ではなく項として足す

以後、優先度に影響する signal を追加するときは **hard tier を増やさず、スコアの項を足す**。hard tier に入れてよいのは「壁時計に対して固く、他のすべての考慮を無効化する」ものだけで、現時点でそれに該当するのは開始直前の会議のみ。

## Consequences

### Positive

- 程度の比較ができる — 110 分後の会議と 3 週間超過タスクの逆転が構造的に解消する
- 「1 日超過」と「3 週間超過」が区別される（tier では同格だった）
- 逆符号の時間項（mention の鮮度 / メールの放置日数）が 1 本のモデルに共存し、tier を 2 つ使う必要がなくなる
- **signal を足しても tier が増えない** — [#448](https://github.com/ozzy-labs/suasor/issues/448) の表面積問題と整合する構造になる
- 説明可能性は主要因表示で維持される（数値は表示の主役にしない）

### Negative / Trade-offs

- **重みの初期値は根拠が薄い** — 実利用での観測に基づく調整が要る（ただし「揺れない基線がコードにある」こと自体は現状からの改善で、[ADR-0041](0041-neutral-demand-priority-substrate.md) と同じ立場）
- ラダーより**推論しにくい** — 「なぜ B が A より上か」を手計算で追うのが難しい。主要因表示と、順序を固定するテストで補う
- [ADR-0041](0041-neutral-demand-priority-substrate.md) / [ADR-0043](0043-email-demand-signals.md) / [ADR-0044](0044-calendar-proximity-signals.md) の順序テストは**全面的な書き直し**が要る
- [ADR-0044](0044-calendar-proximity-signals.md) の `meeting_prep` tier と [ADR-0043](0043-email-demand-signals.md) の `aging_demand` tier は**項に降格**する（signal の定義自体は不変）
- 設定で調整できないため、重みが合わない利用者には会話文脈での上書き以外の逃げ道がない

## Alternatives Considered

- **tier ラダーを維持（`starting_soon` の窓を 30 分に縮めるだけ）** — 却下。110 分の逆転は消えるが、程度を比較できない構造は残る（「1 日超過」と「3 週間超過」は同格のまま）。何より signal を足すたびに tier が増える成長構造が [#448](https://github.com/ozzy-labs/suasor/issues/448) と衝突し続ける
- **hard tier を置かず全面的にスコア** — 却下。15 分後に始まる会議がスコア次第で 2 番目に落ちうる。壁時計に対して固い項目は、重みの調整ミスで沈んではならない
- **重みを config で調整可能にする** — 却下。順序の問題を調べるのにユーザー設定の再現が要るようになり、テストは「既定値での順序」しか保証しなくなる。個人差は会話文脈での上書きで吸収する
- **名前付き profile（`deadline-first` / `people-first`）を選ばせる** — 却下。可変性の代償（検証すべき組み合わせの増加）を払いながら、「自分に合う profile を選ぶ」という判断をユーザーに押し付ける。まず単一の既定を実データで磨く方が先
- **ML / 学習ベースのランキング** — 却下。[ADR-0006](0006-ml-delegation.md) に抵触し、説明可能性を失う。決定論的な算術で十分（[ADR-0041](0041-neutral-demand-priority-substrate.md) と同じ判断）
