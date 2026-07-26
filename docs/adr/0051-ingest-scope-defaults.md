# 0051. 取り込みスコープの既定値を直す（google `calendarIds` 複数化 / ms-graph `user` の既定 `"me"` 撤去）

- Status: Accepted
- Date: 2026-07-27
- Deciders: Suasor maintainers
- Related: [ADR-0007](0007-connector-contract.md)（connector 契約・no silent wrong answer — 本 ADR の判断基準）, [ADR-0049](0049-connector-readiness-parity.md)（readiness / doctor / drift parity — 本 ADR は決定 3 の google 例外と Alternatives (h) を**覆す**）, [ADR-0050](0050-multi-account-connectors.md)（multi-account — externalId 名前空間化の論理を 1 階層下へ写す）, [ADR-0042](0042-slack-workspace-less-connector.md)（決定 9 の「移行は自動変換せず読み込み時エラーで案内する」先例）, [ADR-0039](0039-conversation-discovery-drift.md)（明示列挙＝データ最小化）, [ADR-0044](0044-calendar-proximity-signals.md)（calendar 取り込み窓）
- Tracks: [#536](https://github.com/ozzy-labs/suasor/issues/536)（[#533](https://github.com/ozzy-labs/suasor/pull/533) / [#535](https://github.com/ozzy-labs/suasor/pull/535) の worker が記録した cross-cutting gap 2 件）

## Context

ADR-0049（readiness / doctor / drift）と ADR-0050（multi-account）は、いずれも**取り込みスコープを取り巻く層**を整備した。しかし 2 つの connector では**スコープの既定値そのもの**が壊れており、どちらの ADR のスコープにも収まらなかった。

**1. google の `calendarId` が単数である。** `suasor google calendars` は複数のカレンダーを列挙するのに、config は 1 つしか持てなかった（`z.string().default("primary")`）。1 アカウントが「自分の予定 + チーム / プロジェクトカレンダー」を持つのは例外ではなく通常であり、その全部を取り込めない。ADR-0050 の multi-account は **account が違うケース**（個人 / 仕事）を解いたが、**1 アカウント内の複数カレンダー**は依然表現できない。

さらにこの単数性は ADR-0049 の drift モデルにも穴を開けていた。決定 3 は「configured な**集合**」に対して visible との差分を出す設計で、集合が存在しない google だけが `driftNote` で機能を辞退している。つまり google は「複数取り込めない」だけでなく「複数を前提とした共通機能から外れ続ける」位置にいた。

**2. ms-graph の `user` の既定 `"me"` が、この connector の認証方式では原理的に解決不能である。** Graph の `/users/me` が「サインイン中のユーザー」を意味するのは **delegated token** の場合だけで、app-only（client credentials）では `me` を**リテラルの id / UPN として扱い 404 を返す**。この connector は `ms-graph/auth.ts` が示すとおり client-credentials 一択であり、delegated 経路は存在しない（実装を確認した上での断定である）。したがって `"me"` はこの connector では**常に誤り**であり、`user` を書き忘れた install は「権限エラーのような 404」を全 resource で受け続ける。

ADR-0049 の reachability probe はこれを `auth test` の 404 として可視化したが、**罠そのものは既定値の側に残っていた**。`requiredSettings` に載せられなかったのは、manifest completeness test が「required キーは空を許容する（`.default("")`）」ことを検証しているのに、`user` の既定が非空（`"me"`）だったからである。つまり検査に載せるには**既定値を変える**しかない。

## Decision

### 決定 1. `calendarId`（単数）を `calendarIds`（複数）にする — 破壊的変更

`[connectors.google].calendarIds: string[]`（既定 `["primary"]` ＝従来の既定と同じ対象）にする。`sync` は**設定された全カレンダーを走る**。

- **`calendarId` は受理しない。** 読み込み時に `ConfigError` で落とし、**書くべき `calendarIds = [...]` の行を名指しする**（flat / `accounts.<account>` の両方を検出する）。ADR-0042 決定 9 が Slack の撤去済み shape に対して採った形と同じで、「親切なエラーが移行手順そのもの」である。
- **暗黙の昇格（`calendarId` を 1 要素の `calendarIds` として読む）は採らない。** 2 つのキーが併存すると優先順位が未定義になる（両方書いたらどちらが勝つ? flat の `calendarId` は `calendarIds` を書いた account に継承されるのか?）。どの答えを選んでも、**既存 config が書いた覚えのない意味を持つ**。1 行の機械的な編集の方が安い。
- `suasor google calendars` の貼り付けブロックは、他の discovery verb（github / jira / notion / box）と**同じ共有レンダラ**で `calendarIds = [ ... ]` を出す。従来の「primary だけ有効・残りはコメント」は、複数を表現できないという撤去対象の制約そのものだった。

### 決定 2. 複数カレンダー時のみ event id を calendar で名前空間化する

externalId は `google:<account>:calendar:<calendarId>:<eventId>`。ただし **configured なカレンダーが 1 つのときは従来どおり名前空間化しない**（`google:calendar:<eventId>`）。

- **名前空間化は correctness 要件**である。1 つの会議は、それが載る**どのカレンダーでも同じ event id を持つ**（ADR-0050 決定 3 が account 間で指摘したのと同じ事実の、1 階層下）。自分の予定とチームカレンダーの両方に同じ会議があれば、名前空間化しない限り **1 本の source を毎 sync 取り合って上書きし合う**。
- **1 つのときに名前空間化しない**のは、ADR-0050 が `default` account を無印に保ったのと同じ理由＝**既存 install の取り込み済み lineage をそのまま生かす**ため。単数カレンダーの install は、この破壊的変更を通っても record が 1 バイトも変わらない（externalId・`meta`・警告文言まで固定してある）。
- 代償は明示する: **2 つ目のカレンダーを足した時点で 1 つ目の event が新 id で再取り込みになり、旧 id の source が残る**。cardinality に依存する意味は ADR-0050 が flat キーで受け入れた二義性と同種で、その代わりに「全ユーザーに再取り込みを強いる」（常時名前空間化）を回避している。
- `meta.calendarId` も**複数時のみ**付ける。複数時は全 record が新規なので生成時から入り、meta だけ後付けされて既存行と食い違う状態を作らない。

### 決定 3. カレンダーは既存の per-resource 隔離層の**単位**にする（新しい層を足さない）

`resources` の展開時に `calendar` を **configured なカレンダー 1 件につき 1 単位**へ割る（label は複数時のみ `calendar[<id>]`）。これで打ち間違えた 1 件は warn + skip になり、読める側のカレンダーを道連れにしない。既存の `per-resource.ts` をそのまま使い、**3 層目の隔離機構は作らない**（ADR-0050 決定 5 と同じ「使われない構造を配らない」規律）。

### 決定 4. google は drift 一般形（`--new`）に**参加する**（ADR-0049 決定 3 の例外を解消）

`DISCOVERY_SPECS.google` に `scope = { key: "calendarIds" }` を宣言し、`driftNote` を削除する。ADR-0049 決定 3 が google を辞退させた理由は「configured な**集合**が無い」であり、その前提は決定 1 で消えた。前提が消えた辞退を残せば、**動くはずの verb を理由付きで拒否し続ける**ことになる。

- `--new` は従来どおり **visible − configured** と **configured − visible** を出すだけで、**取り込まない・config に書かない**（ADR-0039 の明示列挙＝データ最小化を維持）。
- Layer 2（sync 時 sweep）/ Layer 3（doctor）は**引き続き一般化しない**。ADR-0049 決定 3 の後半（コスト構造が Slack と違う）はそのまま生きている。

### 決定 5. ms-graph の `user` は既定を空にし、`requiredSettings` に載せる

- schema の既定を `""` にする。これで manifest completeness の不変条件（required キーは `.default("")` ＝空許容）と**整合したまま** `requiredSettings` に載せられる。doctor の `connectors.config` が **ERROR** で報告し、sync の pre-flight にも 1 行出る（ADR-0049 決定 2 の機構をそのまま使い、新しい検査系統を作らない）。
- **「delegated なら `me` が正しい」ことは検査とメッセージで表現する。** 一律に必須化して delegated を壊す、という批判は本 connector には当たらない — この connector は app-only 専用で delegated 経路を持たないことを実装で確認した。したがって:
  - sync が落ちるときのメッセージは「`user` が要る」だけでなく **なぜ `me` にフォールバックできないのか**（app-only にはサインイン中のユーザーが居ない）を述べる。
  - `user` を明示的に `"me"` と書いた config は**そのまま probe する**。app-only で 404 になる事実を隠さないためで、将来 delegated 経路が入れば `me` は正当になる。**その時点で本決定は見直す必要がある**（この ADR は「app-only 専用である」という前提の上に立っている）。
- 既存 install への影響は「**もともと壊れていた config が、静かな 404 から明示的な設定エラーに変わる**」だけである。`user` を書いてある install は無影響で、書いていない install が意味を変えて別の対象を読むことは起きない。

### 決定 6. 「設定されているのに何も probe できない」を `UNKNOWN` として出す

`user` 未設定（ms-graph）/ `calendarIds` が空（google）で reachability probe の対象が無いとき、**行を消さずに `UNKNOWN — not probed: <理由>`** を出す。

行を消すと「そんな resource は設定されていない」と読めてしまい、`REACHABLE` に丸めるのは論外である。ADR-0049 の 3 値語彙は「**事実が確立したか**」を基準にしており、「そもそも訊いていない」は timeout と同じく未確立である。加えて `calendarIds` が空 + `calendar` が `resources` にある状態は `noopWarning`（WARN）でも報告する（静かな 0 件は ADR-0007 の失敗形）。

## Consequences

### Positive

- **1 アカウントの複数カレンダー（自分 + チーム）を取り込める。** 秘書の基質のうち calendar が構造的に 1 本しか入らない状態が解消する。
- google が drift 一般形に載り、ADR-0030 が却下したはずの per-connector 例外が 1 つ減る。「見えているのに config に無いカレンダー」が `google calendars --new` で出る。
- ms-graph の `user` 未設定が、全 resource の 404（権限エラーに見える）ではなく **doctor の 1 行の設定エラー**になる。cron / CI が gate できる。
- 単数カレンダーの既存 install は、externalId も meta も警告文言も**変わらない**。破壊的なのは config キーの綴りだけで、取り込み済みデータは動かない。
- 打ち間違えた 1 件のカレンダーが、他のカレンダーを道連れにしない（per-resource 隔離の単位に載ったため）。

### Negative / Trade-offs

- **`calendarId` を書いている全 install が起動しなくなる**（読み込み時 `ConfigError`）。意図した挙動で、メッセージが移行手順そのものだが、無移行ではない。
- **2 つ目のカレンダーを足すと 1 つ目の event が再取り込みになり、旧 id の source が残る**（決定 2）。`source forget` で掃除できるが自動ではない。
- externalId の形が **configured なカレンダー数に依存する**（1 件なら無印、2 件以上なら名前空間付き）。ADR-0050 の flat キー同様、文脈依存の二義性が 1 つ増えた。
- `auth test` の往復回数が「1 + configured resource 数」から「1 + resource 数 − 1 + **カレンダー数**」に増える。明示的な health コマンド上のコストで `--no-probe` で戻せる。
- `google calendars` の貼り付けブロックが**可視カレンダー全件**を列挙する（従来は primary のみ有効）。他 connector と同じ house style だが、不要な行を消す一手間が増える。祝日カレンダー等をそのまま貼ると取り込み対象が広がる。
- ADR-0049 の決定 3（google の drift 辞退）と Alternatives (h)（配列化を却下）は本 ADR で覆っており、当該 ADR は**その部分だけ歴史的記述**になった（該当箇所に注記を置いた）。

## Alternatives Considered

- **(a) `calendarId` を受理し続け、1 要素の `calendarIds` へ暗黙昇格する** — 却下（決定 1）。併存する 2 キーの優先順位・継承規則が未定義になり、既存 config が書いた覚えのない意味を持つ。「黙って別の意味になることだけは避ける」という要件そのものに反する。
- **(b) `calendarIds` を受理しつつ `calendarId` を deprecation warning に留める** — 却下。warning は読まれないまま残り、上の二義性を抱えた 2 経路を保守し続けることになる。ADR-0042 決定 9 が同じ判断で hard cut を選んでいる。
- **(c) event id を常に calendar で名前空間化する（単数でも）** — 却下（決定 2）。対称性は上がるが、**カレンダーを 1 つしか使っていない全ユーザー**の取り込み済み lineage が切れて重複 source が残る。ADR-0050 の (b) を却下したのと同じ理由で、対価に見合わない。
- **(d) 名前空間化せず、重複 event は後勝ちにする** — 却下。同じ会議でも calendar ごとに `role` / `response` / 更新時刻が違うため、毎 sync で `SourceBodyUpdated` を撃ち合う。ADR-0050 が「1 本の source を取り合う」と名指しした失敗そのもの。
- **(e) カレンダーごとに新しい隔離層を足す** — 却下（決定 3）。既存の per-resource 隔離が単位を差し替えるだけで同じ意味論を与える。層を増やす理由が無い。
- **(f) `user` を必須にせず、`me` のまま reachability probe の 404 に任せる** — 却下（決定 5）。ADR-0049 が可視化したのは**症状**で、既定値という**原因**は残る。`auth test` を叩かない運用では 404 は sync の 0 件として現れるだけである。
- **(g) app-only を検出して `user` を自動解決する（例: 最初のユーザーを選ぶ）** — 却下。「誰のメールボックスを読むか」を Suasor が推測するのは、データ最小化（ADR-0003）と no silent wrong answer（ADR-0007）の両方に反する。
- **(h) google の drift 参加を見送り、`driftNote` を「複数化したが Layer 1 は次回」に書き換える** — 却下（決定 4）。`scope` の宣言 1 つで動く一般形を、理由を書き換えてまで辞退する意味が無い。ADR-0030 が警戒した「connector ごとの専用事情」を延命させるだけである。
