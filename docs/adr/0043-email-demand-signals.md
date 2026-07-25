# 0043. Email demand signals（自分宛て未返信スレッド + aging）

- Status: Accepted（2026-07-25 承認）
- Date: 2026-07-25
- Deciders: Suasor maintainers
- Related: [ADR-0041](0041-neutral-demand-priority-substrate.md)（本 ADR が email signal を追加する中立基質）, [ADR-0012](0012-slack-demand-digest.md)（demand の先行形・no-fetch-at-query 原則）, [ADR-0007](0007-connector-contract.md)（connector は状態を持たない）, [ADR-0002](0002-event-sourced-architecture.md)（seen-state は event）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（返信は HITL）, [ADR-0022](0022-person-identity-resolution.md)（person identity）, [ADR-0036](0036-task-external-home.md)（差別化＝横断捕捉 + 優先付け）
- Tracks: [#476](https://github.com/ozzy-labs/suasor/issues/476)（決定）/ [#449](https://github.com/ozzy-labs/suasor/issues/449)（connector roadmap: email/calendar parity）

## Context

email は秘書基質の原型（「返した / 返してない」が仕事の単位そのもの）なのに、Suasor には **email 専用設計が 1 本もない**。Gmail / Outlook 取り込みは全文検索の材料としてだけ存在する。

一方 demand の**中立基質は [ADR-0041](0041-neutral-demand-priority-substrate.md) で実装済み**（`demand.list` + `demand_seen` + 決定論 scorer）。つまり email demand は並行ツールを作る話ではなく、**既存の demand 導出面に email 由来の signal を足す**話になる。ここで 4 つの具体的な障害が判明した:

1. **ingest が signal を捨てている** — 現在の `gmail_message` / `ms365_mail` の `meta` は `{ resource, id }` だけ。宛先（To/Cc）も送信者もスレッド id も既読状態も保存していない。demand 導出は query 側（追加 fetch なし、[ADR-0012](0012-slack-demand-digest.md) 決定 1）なので、**ingest が持っていない情報からは demand を導出できない**。しかも Gmail は既に `messages.get`（full）を叩いていて header を読み捨てており、Graph も `$select` に足すだけ — **追加リクエストはゼロ**で取れる。
2. **「自分」が識別できない** — Slack には `self_user_ids` があるが、email 側に相当する自アドレス設定がない。「自分宛て」も「自分が返信済み」も判定できない。
3. **email demand は Slack demand と時間特性が逆** — mention は古くなるほど陳腐化する（対応機会を逃した）が、**未返信メールは古いほど深刻になる**。ADR-0041 の scorer は demand tier を「鮮度順」だけで並べるので、3 週間放置された直宛メールが今朝の Slack mention より下に沈む。これは秘書として最悪の失敗モードで、まさに「AI 秘書に期待する catch」そのものを落とす。
4. **mailbox は Slack と桁が違う** — newsletter / 通知メールは平気で To に自分を入れてくる。素朴な「To に自分 && 未返信」は demand tier をゴミで埋め、[ADR-0041](0041-neutral-demand-priority-substrate.md) が解消したはずの「未処理の山」を email で再現する。

## Decision

**email demand を「自分宛ての未返信スレッド」として ingest 済み meta から query 側で導出し、`demand.list` の第 3 の source として基質に載せる。aging（放置日数）を scorer の一級規則として導入する。**

### 決定 1: ingest に connector 中立の email meta を持たせる（前提条件）

`gmail_message` / `ms365_mail` の `meta` に、**両 connector で同じキー名**の以下を追加する（SQL 分岐を connector ごとに増やさないため。キー名の統一が本決定の要点）:

| meta key | Gmail | Microsoft Graph |
| --- | --- | --- |
| `thread` | `threadId` | `conversationId` |
| `from` | `From` header のアドレス部（小文字化） | `from.emailAddress.address`（小文字化） |
| `to` | `To` header のアドレス配列（小文字化） | `toRecipients[].emailAddress.address` |
| `cc` | `Cc` header のアドレス配列（小文字化） | `ccRecipients[].emailAddress.address` |
| `unread` | label に `UNREAD` を含むか | `isRead === false` |
| `bulk` | `List-Id` / `List-Unsubscribe` header の有無 | `List-Unsubscribe` header の有無 |

追加コストは **API リクエスト 0**（Gmail は取得済み payload の header を読むだけ、Graph は `$select` にフィールドを足すだけ）。アドレスは小文字化して格納する（比較を SQL 側で `LOWER()` せずに済ませ、index も効く）。

`bulk` は「To に自分が入っている newsletter」を **ingest 時点で** 落とすためのフラグで、query 側の予測不能なヒューリスティック（件名の正規表現など）を持ち込まないための選択。header の有無という機械的事実のみを保存し、判断は query 側の 1 条件に閉じる。

### 決定 2: 自アドレスは config で明示する（`self_addresses`）

`[connectors.google]` / `[connectors.ms-graph]` に `self_addresses: string[]` を追加する（Slack の `self_user_ids` と同型）。空なら email demand は**常に空**（Slack の `self_user_ids` 未設定時と同じ挙動）で、`doctor` が設定を促す。

API から自動導出（Gmail `users.getProfile` / Graph `/me`）**しない**理由: ① query 時 fetch なしの原則を守る、② 実務ではエイリアス・旧アドレス・配布リスト（`team@`）宛ても「自分宛て」であり、API が返す 1 つのプライマリアドレスでは足りない、③ 明示リストなら「なぜこれが demand なのか」がユーザーに説明可能。`onboard` はアカウントのアドレスを初期値として提案する（提案 → 確認、[ADR-0029](0029-onboarding-wizard.md)）。

### 決定 3: demand は「スレッド単位の未返信」— 最新 inbound を代表行にする

`source_type IN ('gmail_message','ms365_mail')` の行のうち、次を**すべて**満たすスレッドが demand:

1. `meta.from` が自アドレス**でない**（inbound）
2. `meta.to` または `meta.cc` に自アドレスを含む（**単に受信箱にある**では足りない — bcc / list 配信を構造的に除外する）
3. `meta.bulk` が真**でない**
4. 同一 `meta.thread` に、**その行より新しい** `meta.from` = 自アドレスの行が**存在しない**（＝未返信）

demand 行は各スレッドの**最新 inbound メッセージ 1 行**（`external_id` がキー）。スレッドに 5 通来ていても demand は 1 件で、これは「1 スレッド＝1 個の未対応」という人の認知と一致する。

`kind` は 2 値:

- `to` — To に自分。直接の依頼・質問（返信が期待されている）
- `cc` — Cc のみ。情報共有（返信は必ずしも期待されていない）

この区別は決定 5 の aging と、`demand.list --kinds` での絞り込みの両方で効く。

**返信すると自動的に消える。** 自分の返信が次の sync で取り込まれた時点で条件 4 が破れ、demand から落ちる（Gmail の `messages.list` も Graph の `/users/{u}/messages` も送信済みを含むため、追加の取り込み設定は不要）。Slack demand が `demand.ack` を明示的に要求するのと違い、**email demand は仕事をした事実そのものが解決になる**。これは基質の一般化として重要な性質で、`demand.ack` は「返信せずに片付けた（別チャネルで対応した / 対応不要と判断した）」場合の脱出口として残る。

**新着で再浮上する。** スレッドに新しい inbound が来ると代表行の `external_id` が変わり、以前の ack は効かなくなる（再び未処理として浮上する）。これは意図した挙動 — 「ack 済みスレッドに催促が来た」はまさに再提示すべき事象。

### 決定 4: `demand.list` の `source` に `email` を足す

`DemandSource` を `slack | github | email` に拡張する。gmail / outlook を別 source にしない理由は、ユーザーの心的モデルが「メール」であって「Gmail か Outlook か」ではないため。どちらの connector 由来かは既存の `sourceType`（`gmail_message` / `ms365_mail`）が保持しており、情報は失われない。

`DemandRecord` に **`ageDays`**（`observed_at` から現在までの経過日数、切り捨て）を追加する。Slack / GitHub 行にも同じく入る（意味は同じ「観測からの経過日数」）が、scorer が規則として使うのは email demand のみ（決定 5）。

### 決定 5: aging を scorer の一級規則にする（`aging_demand`）

[ADR-0041](0041-neutral-demand-priority-substrate.md) 決定 3 の基線に規則を 1 つ挿入する:

```text
overdue > aging_demand > un-acked demand（鮮度順） > dueDate 近接 > priority > 更新新しさ
```

- **`aging_demand`** = `kind: "to"` の un-acked email demand で `ageDays >= 3`
- この tier 内は **古い順**（`ageDays` 降順）。demand tier が新しい順なのと逆で、意図的 — 放置が長いものほど上に出す
- `cc` は aging しない（返信義務が弱いものを日数だけで昇格させると、また tier がゴミで埋まる）
- しきい値 3 日は初期値（`ageDays >= 3` = 「週の反対側まで放置した」の意）。ADR-0041 同様、値は tuning 対象だが**順序はコードとテストが保証する**

`aging_demand` を `overdue` の**下**に置くのは、明示的な期限（task / commitment の期日超過）はユーザーが自分で宣言した約束であり、推定された緊急度より常に強いため。

### 決定 6: 送信者の重み付け（boss / VIP）は本 ADR の範囲外

「上司からのメールを上げる」は価値が明確だが、person の重要度モデル（[ADR-0022](0022-person-identity-resolution.md) の identity に重み属性を足すか、interaction 頻度から導出するか）という別の決定を要する。ここで片手間に `important_senders` 設定を足すと、後で正しいモデルが来たときに二重の設定面が残る。**未対応と明示して先送りする**。aging + `to`/`cc` の区別だけで、実運用の大半の catch は取れる見込み。

> **Extended by [ADR-0044](0044-calendar-proximity-signals.md)（2026-07-25）:** 決定 5 の基線に
> calendar tier（`starting_soon` / `meeting_prep`）が加わった。`aging_demand` の位置づけ（overdue の下）は不変。

## Consequences

### Positive

- email ユーザーが Slack ユーザーと同等の triage を得る（[ADR-0041](0041-neutral-demand-priority-substrate.md) が宣言した signal parity の完成に一歩）
- 「3 週間返してない直宛メール」という、人が最も落とす種類の球を構造的に拾う（`aging_demand`）
- **返信すれば黙る** — ack を要求しないので、秘書ツールにありがちな「二重に片付ける」手間がない
- newsletter を構造的に（header という機械的事実で）除外するので、demand tier が汚染されない
- 追加の API コストがゼロ（既に取得している情報を捨てるのをやめるだけ）

### Negative / Trade-offs

- `meta` に個人情報（メールアドレス）がローカル DB へ入る。local-first（[ADR-0003](0003-local-first-and-content-minimization.md)）なので外部送信はないが、`source forget`（[ADR-0026](0026-source-forgetting.md)）の対象範囲として明示が要る
- `self_addresses` 未設定だと email demand が黙って空になる（`doctor` の completeness signal で補う。Slack の `self_user_id` と同じ弱点を継承する）
- 未返信判定は**取り込み済みの範囲でしか正しくない** — sync していない期間に返信していれば、次の sync まで demand に残る（誤検知の方向。逆に見落とす方向ではないので安全側）
- 別クライアントで返信し、かつ送信済みを sync 対象外にしている構成では自動解決が効かない（`demand.ack` が脱出口）
- scorer の tier が 1 つ増える（`PriorityReason` の値が 5 → 6）。既存の順序テストの改訂が要る

## Alternatives Considered

- **「未読」を demand にする** — 却下。未読は端末をまたいで信頼できず（別クライアントで開いただけ、通知センターで既読になる）、何より**「読んだが返していない」という最も重要な状態を取りこぼす**。`unread` は補助情報として meta に保持するに留める
- **メッセージ単位で demand を立てる** — 却下。1 スレッドの往復がそのまま demand 件数になり、「未処理 5 件」が実際は 1 件の会話、という嘘の数字を出す
- **スレッド id ではなく件名でスレッドをまとめる** — 却下。`Re:` の正規化は言語・クライアントごとに壊れる。両 API が正規のスレッド id を返しているのに推測する理由がない
- **LLM に「返信が必要か」を判定させる** — 却下。[ADR-0006](0006-ml-delegation.md)（決定論で足りるものに ML を持ち込まない）に抵触し、同じ受信箱で実行ごとに結果が揺れる。demand の**列挙**は決定論、個別の**下書き**は host LLM（`reply-draft` skill、HITL）という既存の分業を崩さない
- **aging を demand tier 内のソート順の変更だけで表現する（tier を増やさない）** — 却下。同一 tier 内で「新しい順」と「古い順」を両立できず、どちらに倒しても片方の signal が沈む。順序規則として明示的に分けた方が、`priority.list` の根拠表示（なぜ上に来たか）も説明可能なままでいられる
- **ingest 時に demand フラグを立てる（projection ではなく取り込み時判定）** — 却下。`self_addresses` の変更や返信の到着で判定が変わるため、状態を書き込むと再計算が必要になる。導出は query 側（[ADR-0012](0012-slack-demand-digest.md) の原則）で保つ
