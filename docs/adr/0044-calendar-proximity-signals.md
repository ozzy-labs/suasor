# 0044. Calendar proximity signals（まもなく始まる予定 + 準備が要る予定）

- Status: Accepted（2026-07-25 承認）
- Date: 2026-07-25
- Deciders: Suasor maintainers
- Related: [ADR-0041](0041-neutral-demand-priority-substrate.md)（本 ADR が calendar signal を追加する中立基質）, [ADR-0043](0043-email-demand-signals.md)（同サイクルの email signal・tier 追加の先行形）, [ADR-0028](0028-task-scheduling-fields.md)（時刻依存状態は read 時派生・`now` 注入）, [ADR-0002](0002-event-sourced-architecture.md)（replay 不変性）, [ADR-0012](0012-slack-demand-digest.md)（no-fetch-at-query）, [ADR-0008](0008-assistant-skills.md)（`meeting-prep` skill）, [ADR-0017](0017-brief-period-bundle.md)（brief への合流）, [ADR-0040](0040-proactive-push-lane.md)（digest の内容源）
- Tracks: [#477](https://github.com/ozzy-labs/suasor/issues/477)（決定）/ [#449](https://github.com/ozzy-labs/suasor/issues/449)（connector roadmap: email/calendar parity）

## Context

calendar の取り込みは google / ms-graph の両方に存在するが、「**まもなく始まる会議**」「**準備が要る予定**」はどの tool にも現れない。カレンダーは全文検索の材料にしかなっていない。設計に入って、より根の深い 3 つの欠陥が判明した:

1. **予定の「開始時刻」がどこにも保存されていない** — calendar 行の `meta` は `{ resource, id }` だけで、`start` / `end` を持たない。`observed_at` は google が `updated ?? start`、graph が `lastModifiedDateTime ?? receivedDateTime ?? start` という**混成**で、「いつ更新されたか」と「いつ始まるか」が同じ列に潰れている。
2. **`meeting-prep` skill が壊れている** — 既存 skill は `source.list` の `observedAfter` / `observedBefore` で「来週の会議」を引く手順になっている。しかし `observed_at` は（多くの場合）**更新時刻**なので、これは「先週更新された予定」を引いており、「来週開催される予定」を引いていない。3 か月前に作られた明日の会議は範囲外に落ち、昨日タイトルを直した先月の会議は入ってくる。skill の記述だけでは直せない（クエリできるデータが無い）。
3. **Graph は繰り返し予定を展開していない** — google 側は `singleEvents: true` で occurrence に展開されるが、graph 側は `/users/{u}/events` を叩いており、これは**繰り返しの series master**（親）を返す。毎週の定例は「2 年前に始まる 1 件の予定」として入っており、proximity をそのまま載せると恒久的に無意味な行を出す。逆に google 側は時間窓の指定が無く、全期間を occurrence 展開している。

つまり calendar proximity は「signal を足す」だけでは成立せず、**取り込みの時間モデルを直すこと**が前提になる。

## Decision

**calendar の時間・役割情報を ingest に持たせ、proximity を [ADR-0028](0028-task-scheduling-fields.md) と同じ read 時派生（`now` 注入可能）として `demand.list` に載せる。時計に対して固い予定（開始直前）を順序の最上位 tier に置く。**

### 決定 1: calendar 取り込みの時間モデルを直す（前提条件）

**a. occurrence 展開と時間窓を両 connector で揃える。**

- ms-graph: `/users/{u}/events` → **`/users/{u}/calendarView?startDateTime=…&endDateTime=…`**（繰り返しを occurrence へ展開して返す。google の `singleEvents: true` と同義）
- google: `events.list` に `timeMin` / `timeMax` を渡す
- 窓は両者とも **`now - 30d` 〜 `now + 90d`** のローリング。過去側は `meeting-followup`（振り返り）が要求する範囲、未来側は「四半期先の予定まで見える」ための実用値

**b. `meta` に予定固有の情報を持たせる**（両 connector で**同じキー名**。[ADR-0043](0043-email-demand-signals.md) 決定 1 と同じ方針）:

| meta key | 意味 | Google | Microsoft Graph |
| --- | --- | --- | --- |
| `start` / `end` | 予定の開始 / 終了（ISO 8601・UTC 正規化） | `start.dateTime` / `end.dateTime` | `start.dateTime` / `end.dateTime`（+ `timeZone`） |
| `allDay` | 終日予定か | `start.date` の有無 | `isAllDay` |
| `role` | 自分の役割: `organizer` / `required` / `optional` / `none` | `organizer.self` / `attendees[].self` + `optional` | `isOrganizer` / `attendees[].type` |
| `response` | 自分の出欠回答: `accepted` / `declined` / `tentative` / `none` | `attendees[].responseStatus`（`self` の行） | `responseStatus.response` |
| `attendees` | 参加者数（人数のみ。アドレスは保存しない） | `attendees.length` | `attendees.length` |
| `hasAgenda` | 説明本文が非空か | `description` | `body.content` |
| `hasAttachments` | 添付があるか | `attachments` | `hasAttachments` |
| `recurring` | 繰り返しの occurrence か | `recurringEventId` の有無 | `seriesMasterId` の有無 |

参加者は**人数のみ**を保存する（[ADR-0003](0003-local-first-and-content-minimization.md) の content minimization。proximity の判定に個々のアドレスは不要で、必要になったら別 ADR で person identity と接続する）。

**c. `observed_at` は「更新時刻」に統一する**（google `updated` / graph `lastModifiedDateTime`）。開始時刻は `meta.start` が正本。両者を同じ列に潰さない — 更新時刻は差分同期と「何が変わったか」の意味論を担っており、そこに開始時刻を混ぜたのが欠陥 2 の原因。

### 決定 2: `source.list` に `startsBetween` を additive 追加（`meeting-prep` の修復）

新しい read tool は作らず、`source.list` に `startsBetween`（`meta.start` に対する範囲フィルタ）を足す（[ADR-0028](0028-task-scheduling-fields.md) 決定 3 と同じ流儀 — 既存 tool の additive 拡張）。`meeting-prep` skill は `observedAfter` / `observedBefore` から `startsBetween` に改訂する。**これで「来週の会議準備」が実際に来週の会議を引く。**

### 決定 3: proximity は read 時派生（sync 時に書かない）

「まもなく始まる」は**現在時刻に依存する状態**であり、[ADR-0028](0028-task-scheduling-fields.md) の overdue と同型の問題を持つ。projection に焼くと ① 数分で陳腐化し ② 別時刻の replay で値が変わって [ADR-0002](0002-event-sourced-architecture.md) の replay 不変性が壊れる。したがって **`meta.start` と注入可能な `now` から query 層で派生**する。テストは `now` を固定して決定論的に書く。

### 決定 4: 2 種類の calendar demand（別々の時計）

`demand.list` の `source` に **`calendar`** を追加し、`kind` を 2 値にする:

| kind | 窓 | 条件 | 意図 |
| --- | --- | --- | --- |
| `meeting_soon` | `now <= start <= now + 120min` | `response != "declined"` かつ `role ∈ {organizer, required}` かつ `allDay` でない | 「そろそろ出る」の一押し |
| `meeting_prep` | `now <= start <= now + 24h` | 上に加えて `hasAgenda` または `hasAttachments` または `role = "organizer"` | 「今夜のうちに準備する」の一押し |

**窓を分けるのが本決定の要点。** 準備は前日に surface しないと行動できず、出席の催促は 24 時間前に出しても邪魔なだけ。同じ「近接」でも人が取る行動が違うので、1 つのしきい値に畳まない。両方に該当する予定（開始 30 分前で agenda あり）は、より強い `meeting_soon` として 1 行だけ出す。

除外の理由:

- **`declined`** — 断った予定は demand ではない（明示的な意思表示を無視してはならない）
- **`optional` のみ** — 任意参加を「まもなく始まる」で割り込ませると、tier がゴミで埋まる（[ADR-0043](0043-email-demand-signals.md) と同じ懸念）
- **終日予定** — 「00:00 に始まる」ので proximity の意味を成さない。終日の予定に準備物がある場合は将来課題

**ack は不要で、時間が解決する。** 予定は `end` を過ぎれば窓から自然に外れる（[ADR-0043](0043-email-demand-signals.md) の「返信すれば消える」と同型の自己解決）。`demand.ack` / `demand.dismiss` は「準備は済んだ」を明示したい場合の脱出口として引き続き効く。

### 決定 5: `starting_soon` を順序の最上位 tier にする

[ADR-0041](0041-neutral-demand-priority-substrate.md) 決定 3 の基線（[ADR-0043](0043-email-demand-signals.md) で `aging_demand` を挿入済み）を、次に更新する:

```text
starting_soon > overdue > aging_demand > meeting_prep > un-acked demand（鮮度順）
  > dueDate 近接 > priority > 更新新しさ
```

- **`starting_soon`**（= `meeting_soon` の行）は **overdue より上**。理由は 1 つ: **予定だけが動かせない**。期限超過の task は 1 時間後にやってもよいが、20 分後に始まる会議は 20 分後にしか出られない。壁時計に対して固い項目は、柔らかい項目より常に上
- tier 内は **`start` の昇順**（近いものから）
- **`meeting_prep`** は `aging_demand` の下・通常 demand の上に独立 tier として置き、tier 内は **`start` の昇順**。「今夜準備しないと明朝に間に合わない」は、今朝届いた Slack DM より締まりが強い

各 tier の並び順規則を 1 つに保つ（tier ごとに単一のソート鍵）ため、tier を増やして混成ソートを避けた。

### 決定 6: 範囲外（明示）

- **移動時間・場所を考慮した繰り上げ通知** — 位置情報と経路データを要し、local-first の egress 方針（[ADR-0003](0003-local-first-and-content-minimization.md)）と正面から当たる
- **ダブルブッキング検出** — 価値はあるが別のクエリ（重なりの検出）と別の UX（どちらを断るかの提案）であり、demand の列挙には収まらない
- **前回 occurrence の未了 action item を prep に合成** — [ADR-0021](0021-commitment-ledger.md) の commitment と会議の紐付けが要る。`meeting_prep` が出た後に `meeting-prep` skill が pull する現行の形で当面足りる

> **決定 4 / 5 は [ADR-0045](0045-priority-ranking-model.md)（2026-07-25）が改訂した:**
> `starting_soon` の窓は 120 分 → **30 分**（唯一の hard tier として残す）、`meeting_prep` tier は
> スコアの項（`prep_urgency`）に降格。取り込みの時間モデル修正（決定 1 / 2）と kind の定義は不変。

## Consequences

### Positive

- 「まもなく始まる会議」が、壁時計に対して固いという性質にふさわしい位置（最上位）に出る
- `meeting-prep` skill の**実際に壊れている時間フィルタが直る**（欠陥 2）— 決定 1 + 2 は proximity 抜きでも単独の価値がある
- Graph の繰り返し予定が occurrence に展開され、google と挙動が揃う（欠陥 3）
- 準備の signal が「前夜に届く」ので行動できる（窓を分けた効果）
- 予定は自然に窓から出るため、ack を強制しない（[ADR-0043](0043-email-demand-signals.md) と同じ性質）

### Negative / Trade-offs

- **tier が 7 段になる**（`starting_soon` / `overdue` / `aging_demand` / `meeting_prep` / demand / `due_soon` / `priority` / recency）。これ以上の追加は tier ラダーではなく重み付きスコアへのモデル変更を検討すべき閾値に近い — 本 ADR はその認識を明記した上で、説明可能性（なぜ上に来たかを 1 行で言える）を優先して tier を選ぶ
- calendarView / `timeMin`-`timeMax` への切り替えは、既存の取り込み範囲を**変える**（過去の広い範囲は再取得されない）。移行注記が要る
- ローリング窓の外に出た occurrence は sync 対象外になる（過去 30 日より前の予定は新規取り込みされない。既に取り込み済みの行は残る）
- proximity は sync の鮮度に依存する — 直前に受諾／辞退が変わっても、次の sync まで反映されない（[#442](https://github.com/ozzy-labs/suasor/issues/442) の sync freshness surfacing と補完関係）
- 参加者を人数しか持たないため、「誰と会うか」で重み付けはできない（[ADR-0043](0043-email-demand-signals.md) 決定 6 の sender 重み付けと同じく、person 重要度モデル待ち）

## Alternatives Considered

- **`observed_at` を予定の開始時刻にする（列を兼用する）** — 却下。`meeting-prep` の時間フィルタは直るが、差分同期と「何が変わったか」の意味論が壊れ、更新されただけの予定が「新しい観測」として brief に湧く。欠陥 2 の原因はまさにこの兼用であり、同じ間違いの方向を強めるだけ
- **proximity を sync 時に projection へ書く** — 却下。数分で陳腐化し、[ADR-0002](0002-event-sourced-architecture.md) の replay 不変性を壊す（[ADR-0028](0028-task-scheduling-fields.md) が overdue で同じ判断をしている）
- **専用の `calendar.upcoming` read tool を作る** — 却下。demand の列挙面を二重化する。[ADR-0041](0041-neutral-demand-priority-substrate.md) が 1 本に統合した意味が失われ、skill 側は「どちらを見ればいいか」を毎回判断することになる
- **`meeting_soon` と `meeting_prep` を 1 つの kind にまとめ、しきい値を 1 つにする** — 却下。準備（前夜）と出席（直前）は取る行動が違い、どちらのしきい値に寄せても片方が使い物にならない。24 時間前に「そろそろ出る」と言われても困り、開始 15 分前に「準備しろ」と言われても手遅れ
- **`starting_soon` を overdue の下に置く** — 却下。overdue は「遅れている（もう破っている）」、starting_soon は「これから物理的に不可能になる」。後者だけが時刻を動かせない
- **すべての予定を proximity に載せる（role / response で絞らない）** — 却下。辞退済み・任意参加が最上位 tier に出るのは、優先付けの信頼を最短で壊す
