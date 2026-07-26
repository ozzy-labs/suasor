# 0050. Multi-account ingestion（`[connectors.<name>.accounts.<account>]`・google / ms-graph）

- Status: Accepted
- Date: 2026-07-26
- Deciders: Suasor maintainers
- Related: [ADR-0007](0007-connector-contract.md)（connector 契約・credential 先行・manifest — 本 ADR が capability を 1 つ足す）, [ADR-0014](0014-slack-multi-workspace.md)（alias パターンの初出。本 ADR が「生き残る部分」を一般化する）, [ADR-0042](0042-slack-workspace-less-connector.md)（Slack から alias を撤去した判断 — 本 ADR はその論理を**反転して適用**する）, [ADR-0049](0049-connector-readiness-parity.md)（readiness / doctor / drift の非 Slack parity — 本 ADR はその検査を per-account 化する）, [ADR-0043](0043-email-demand-signals.md)（`self_addresses` — account をまたいで union する対象）, [ADR-0003](0003-local-first-and-content-minimization.md)（明示列挙）
- Tracks: [#441](https://github.com/ozzy-labs/suasor/issues/441)（ADR 敵対的検証 [#412](https://github.com/ozzy-labs/suasor/issues/412) の major `slack-4`）
- 表記の更新（2026-07-27・[#536](https://github.com/ozzy-labs/suasor/issues/536)・[ADR-0051](0051-ingest-scope-defaults.md)）: 本文で account 相対スコープの例に挙げた `calendarId = "primary"` は **`calendarIds = ["primary"]`** に、`user = "me"` は **`user = "someone@contoso.com"`**（`"me"` は app-only では解決不能なため既定から撤去）に置き換わった。**決定は無変更** — スコープが account 相対の名前で書かれるという論拠も、決定 3 の「`default` を無印に保つ」も成立したままである。ADR-0051 決定 2 は決定 3 の名前空間化の論理を、account の 1 階層下（1 アカウント内の複数カレンダー）へ写している。

## Context

秘書にとって最重要の基質は mail / calendar / files である。そして実務上、それは**個人アカウントと仕事アカウントに分かれている**。ところが multi-account 取り込みができるのは Slack だけで、google / ms-graph は `[connectors.google]` が 1 つ、credential も `connector:google:refreshToken` が 1 つ、と**構造的に 1 アカウントしか持てない**。「個人 Gmail と仕事 Gmail の両方を見る」は設定で表現できない。

[#441](https://github.com/ozzy-labs/suasor/issues/441) の起票時点の指示は「[ADR-0014](0014-slack-multi-workspace.md) の alias パターン（per-alias config table / per-alias secret 命名 / alias ネスト cursor / per-alias エラー隔離）を connector 契約の汎用 capability に一般化し、google / ms-graph に実装する」だった。しかし起票後に [ADR-0042](0042-slack-workspace-less-connector.md)（[#464](https://github.com/ozzy-labs/suasor/issues/464)）が **Slack から alias を撤去**している。したがって本 ADR はまず「撤去された設計を他 connector に配って良いのか」に答える必要がある。**答えは「配って良い部分と、配ってはいけない部分がある」** で、その線引きが本 ADR の中心である。

## Decision

### 1. alias 撤去の論理は google / ms-graph には**当てはまらない** — account は名前を持つ

[ADR-0042](0042-slack-workspace-less-connector.md) が Slack の alias を捨てられたのは、**Slack の取り込みスコープが globally unique な id で書かれている**からである。`channels = ["C0123"]` の `C0123` は Slack 全体で一意なので、「どの workspace の C0123 か」を言う必要がない → config は flat な id リストに畳め、credential は**無名の token プール**にできる（どの token で読んでも同じ channel）。

google / ms-graph はここが構造的に違う。取り込みスコープが**アカウント相対の名前**で書かれている:

| connector | スコープを書く key | 実際に指すもの |
| --- | --- | --- |
| google | `calendarId = "primary"` | **その credential の持ち主の**主カレンダー |
| google | `resources = ["gmail"]` | **その credential の持ち主の**メールボックス |
| ms-graph | `user = "me"` / `user = "u@contoso.com"` | **その tenant の**ユーザー |

`primary` も `me` も、credential を替えれば別の対象を指す。無名の token プールにすると **「誰の `primary` か」を config が言えなくなる**。よって google / ms-graph では **account に名前を付ける必要がある**。ADR-0042 の結論は「alias は一般に不要」ではなく「**globally unique な id でスコープを書ける connector では不要**」であり、本 ADR はその条件節を明示して反転適用する。

同じ基準を全 connector に当てて manifest に `multiAccount` を宣言させる（[ADR-0007](0007-connector-contract.md) の completeness test が config schema と突き合わせる）。`github`（`owner/repo`）/ `notion`（database id）/ `jira`（`host` が site を名指す）/ `slack`（channel id）/ `web`・`local`（URL / 絶対パス）はいずれも **id 側が既に一意**なので `false`。`box` は folder id がアカウント相対なので**真の候補だが本 PR のスコープ外**で、`multiAccount: false` の宣言にその旨を注記する（無言の欠落にしない）。

> **追記（2026-07-27・[#537](https://github.com/ozzy-labs/suasor/issues/537)）**: box を採用済みにした（`multiAccount: true`）。基準の当てはまりは Box 側の documented な事実で裏が取れている — **root folder は全アカウントで id `0`**（[Box API reference](https://developer.box.com/reference/get-folders-id/)）なので、`folders = ["0"]` は account を名指すまで「誰の root か」を言えない。externalId の名前空間化（決定 3）も box では別根拠で必須になる: **collaboration で共有されたファイルは複製ではなく同一オブジェクト**なので、個人 box と仕事 box の双方に共有された 1 ファイルは**両アカウントで同一の file id** を返す。加えて Box は file id の一意性スコープを規定しておらず、この id 族で規定がある唯一の id（root folder `0`）は account 相対なので、「file id は globally unique だろう」という**未検証の前提には依存しない**方針を採った（判定不能を推測で埋めない・[ADR-0049](0049-connector-readiness-parity.md) の規律）。したがって multi-account 対応 connector は **google / ms-graph / box** の 3 つである。

### 2. config: `[connectors.<name>.accounts.<account>]`、flat キーは**継承の既定値**

```toml
[connectors.google]
clientId = "shared.apps.googleusercontent.com"   # 全 account が継承
resources = ["gmail", "calendar"]

[connectors.google.accounts.personal]
self_addresses = ["me@personal.example"]

[connectors.google.accounts.work]
calendarId = "me@work.example"
resources = ["gmail", "calendar", "drive"]
self_addresses = ["me@work.example", "team@work.example"]
```

- `accounts` テーブルが無ければ、**flat キーがそのまま `default` という 1 アカウント**になる（後述 決定 3）。
- `accounts` テーブルがあれば、flat キーは**各 account が override しなかったキーの既定値**になる。OAuth client id が 1 つで account が N 個、という現実の形をそのまま書けることを優先した。
- **継承の解決は raw な slice の merge で行う**（`src/connectors/multi-account.ts` の `accountSlices`）。Zod の `.default(...)` は `.partial()` を通しても適用されるため、schema で parse した account からは「未指定」と「既定値を明示指定」が区別できない — 検証で確かめた上で、schema は**検証専用**とし effective config は raw merge から作る。
- account 名は `[A-Za-z0-9][A-Za-z0-9_-]*` に制限し、**env override 名が衝突する組（`work-a` と `work_a` → どちらも `..._WORK_A_...`）は load 時に拒否**する。名前は keychain account・env var・externalId の 3 つの名前空間に射影されるので、ここで弾かないと「片方の token がもう片方の答えをする」無音の取り違えになる。
- account テーブル内も **strict**（未知キー拒否）。`loadConfig` は top-level にしか `.strict()` を掛けないので、nested の strict は schema 側で宣言する。

**flat キーが `accounts` 併存時に「取り込まれる account」ではなくなる**点は意図的な非対称であり、その代償（既存 flat config に named account を足すと flat 側の取り込みが止まる）は**放置しない** — 決定 5 で doctor が名指しする。

> **追記（2026-07-27・[#538](https://github.com/ozzy-labs/suasor/issues/538)）**: `suasor onboard --account <name>`（[ADR-0029](0029-onboarding-wizard.md)）が 2 つ目の account を扱うようになったので、**降格を起こす当のコマンド**が先回りで塞ぐ経路も加わった: 既存 flat config に最初の named account を足すとき、無印 default の credential が解決できるなら `[connectors.<name>.accounts.default]` を一緒に書く。解決できないなら**書かず**規則だけ述べる（credential 無し account を 1 つ増やすと決定 4 により毎 sync が warn 付き skip + exit 非 0 になるため）。これは決定 5 の 2 段の確信度をそのまま写したもので、**決定は無変更** — doctor は引き続き恒常的な検出器であり、ウィザードは自分が起こした降格だけを扱う。

### 3. secret / identity: `default` account だけ**無印**（既存 install を壊さない）

| | `default` account | 名前付き account |
| --- | --- | --- |
| keychain | `connector:google:refreshToken` | `connector:google:work:refreshToken` |
| env override | `SUASOR_CONNECTOR_GOOGLE_REFRESHTOKEN` | `SUASOR_CONNECTOR_GOOGLE_WORK_REFRESHTOKEN` |
| externalId | `google:<resource>:<id>` | `google:work:<resource>:<id>` |

- secret 命名は既存の `secretEnvName` 規約からの自然な導出で、**新しい機構を足していない**（[ADR-0014](0014-slack-multi-workspace.md) 決定 2 と同型）。
- **externalId の per-account 名前空間化は correctness 要件**であり装飾ではない。Gmail の message id は**メールボックス内でしか一意でなく**、Calendar の event id は**同じ会議が各出席者のカレンダーで同じ id を持つ**。名前空間化しなければ、個人と仕事の両方に入っている 1 つの会議が **1 本の source を取り合って毎 sync 上書きし合う**。
- `default` を無印に保つことで、**既存 install は無移行**である: keychain も env も既に取り込んだ source lineage もそのまま生きる。2 つ目の account はテーブルを 1 つ足すだけで増える。
- 1 つ目の account を明示的に書きたい場合は `[connectors.<name>.accounts.default]`（空テーブルで可・flat を継承）と綴る。**`default` という名前が「無印」を意味する**という規則ひとつで、後方互換と明示性を両立する。

### 4. エラー隔離: account 層 → resource 層の 2 段（[ADR-0014](0014-slack-multi-workspace.md) 不変条件の写像）

- 1 account の失敗（token 失効・tenant 設定不備）は**他の account を止めない**。
- credential を持たない account は **failure ではなく warn 付き skip**（[ADR-0007](0007-connector-contract.md) の multi-account 条項）。中央 credential 検査は any-of なので、**全 account に credential が無いときだけ throw** する。
- **全 account が失敗したら throw**（全滅は部分成功ではない）。全 account が skip でも throw する（そこに到達したなら、無音の 0 件成功になってしまう）。
- **skip も failure も `partialFailure`**（exit 非 0、[ADR-0027](0027-bulk-sync-orchestration.md)）。config が宣言した account が 1 件も取り込まなかった事実を cron / CI が gate できないと、「半分だけ同期されている」状態が exit 0 の裏に隠れる。
- 一方 **`resources = []` の account は no-op であって degradation ではない**（従来どおり 0 件・exit 0）。意図的に絞った config の exit code を変えない。
- account 層の下は既存の per-resource 隔離（`per-resource.ts`・[#193](https://github.com/ozzy-labs/suasor/issues/193)）をそのまま使う。account 内の全 resource 失敗は account 層が受け止める。
- **単一 account（`accounts` テーブル無し）の出力は 1 バイトも変わらない**: prefix も summary 行も partialFailure も付かない。後方互換はテストで固定してある。

### 5. cursor: **今は作らない**（規約だけ定める）

[ADR-0014](0014-slack-multi-workspace.md) の 4 要素のうち **alias ネスト cursor だけは実装しない**。google / ms-graph は fingerprint ベースで `cursor: null` を返す（delta API を使っていない）ため、ネストする cursor が**存在しない**。使われない構造を配らないのは [ADR-0049](0049-connector-readiness-parity.md) 決定 3 と同じ規律である。

将来 cursor を持つ connector（例: github の共有 `since`）を multi-account 化するときの**規約だけ**先に定める: `{"<account>": <cursor>}` の nest、flat な旧形式は `default` account 配下として解釈。実装はその PR で行う。

### 6. doctor / auth verb: [ADR-0049](0049-connector-readiness-parity.md) の検査を**そのまま per-account 化**する

新しい検査系統は作らず、#478 が入れた形をアカウント軸に展開する（設計を作り直さない）:

| 検査 | per-account 化 |
| --- | --- |
| `connectors`（credential 不在） | account ごとに probe し、`google (account 'work')` と名指す。**1 つ揃っていれば ok** にしない |
| `connectors.config`（`requiredSettings` 空・ADR-0049 決定 2） | account ごと。修正先も `[connectors.google.accounts.work]` と account のテーブルを指す |
| `connectors.noop`（scope 空） | account ごと |
| `connectors.self_addresses`（[#488](https://github.com/ozzy-labs/suasor/issues/488)） | account ごと（未設定になりがちなのは大抵 work 側） |
| `<connector> auth test` の scope / reachability probe（ADR-0049 決定 1） | `--account` で 1 件、省略時は**全 account** を順に検査。単一 account なら出力・JSON 形状とも従来どおり |
| `connectors list` / `config show` の credential presence | account ごと。1 枚の token が connector 全体を `configured` に見せない |

新規は `connectors.accounts` 1 つだけで、これは決定 2 の非対称（flat キーの降格）を報告する。**確信度で 2 段に分ける**:

- 無印 `default` の credential が**まだ保管されている** → その account は実在した証拠がある → **warn**（「もう同期されていない」と言い切る）。
- credential が無い → 「元々 default account が無かった」と「あったが credential も消した」が**区別できない** → **info**（規則を述べるだけで、この install の履歴について何も主張しない）。

これは [ADR-0048](0048-at-rest-protection.md) / [ADR-0049](0049-connector-readiness-parity.md) の「判定不能を推測で埋めない」規律の適用である。

### 7. `self_addresses` は account をまたいで **union** する

email demand（[ADR-0043](0043-email-demand-signals.md)）の「自分」は 1 人であって account ごとに別人ではない。仕事アドレス宛のスレッドは、どちらの account が取り込んでも自分宛である。flat キーだけを読むと named account のアドレスが**demand 述語から丸ごと見えなくなる** — つまり「demand が常に空」という、doctor がまさに警告している失敗形になる。

## Consequences

### Positive

- **個人 + 仕事の mail / calendar / files を 1 install で取り込める**（本 issue の目的）。秘書の基質が構造的に半分しか入らない状態が解消する。
- **既存 config・既存 credential・既存 source lineage は無改修で動く**（決定 3）。移行手順が要らない。
- 「半分だけ設定できている」状態が **doctor / `auth test` / `connectors list` の全部で account 名付きで出る**。1 枚の token が connector 全体を健康に見せることが無くなる。
- multi-account が **manifest capability + 共有モジュール**になったので、次の connector（box）は config schema 1 行 + `multiAccount: true` + sync のラップで足りる。completeness test が宣言漏れを落とす。**（[#537](https://github.com/ozzy-labs/suasor/issues/537) で実測: box の採用は `src/connectors/box.ts` だけの変更で済み、CLI（`--account`）・doctor・`connectors list` / `config show` の per-account 表示・credential probe は manifest 宣言だけで通った。この予測は当たった。）**

### Negative / Trade-offs

- **flat キーの意味が文脈依存になる**（`accounts` の有無で「1 アカウント」か「既定値」か）。決定 5 の doctor 検査で緩和するが、概念としての二義性は残る。
- **account 名が externalId に入る**ので、account を rename すると **その account の source lineage が切れる**（新 id で再取り込み、旧 id は残る）。identity は不変であるべきという [ADR-0002](0002-event-sourced-architecture.md) の立場からは正しい挙動だが、rename は無害ではない — guide に明記する。
- flat → named account への移行時、`[connectors.<name>.accounts.default]` を書かないと従来分の取り込みが止まる（決定 5 が検出する）。
- `auth test` を account 指定なしで実行すると **account 数だけ round-trip する**。明示的な health コマンドなので許容する（`--account` で 1 件に絞れる）。
- cursor のネスト規約は**宣言のみで未実装**（決定 5）。cursor を持つ connector を multi-account 化する PR がここを埋める。

## Alternatives Considered

- **(a) ADR-0042 の無名 token プールを google / ms-graph にもそのまま配る** — 却下（決定 1）。`calendarId = "primary"` / `user = "me"` が「誰の」を言えなくなる。ADR-0042 の前提（スコープが globally unique な id で書ける）が成立しない。
- **(b) 全 account を prefix する（`default` も `google:default:<resource>:<id>`）** — 却下（決定 3）。対称性は上がるが、既存 install の取り込み済み source が全部別系統になり再取り込みが要る。ADR-0042 は Slack で同種の破壊を受け入れたが、それは identity の非対称を消すという**別の対価**があったからで、ここには対価が無い。
- **(c) connector を account ごとに別登録（`google@work` のような動的 registry）** — 却下。[ADR-0014](0014-slack-multi-workspace.md) Alternatives と同じ理由で、registry が動的になり manifest / 運用 verb / freshness 集計の共有が崩れる。1 connector + account パラメタが筋。
- **(d) 継承なし（各 account が全キーを書く）** — 却下（決定 2）。`clientId` は現実には全 account 共通なので、継承が無いと同じ値を N 回書かせることになり、片方だけ更新して食い違う典型的な事故を招く。
- **(e) flat キーを `accounts` 併存時も暗黙の追加 account として扱う** — 却下（決定 2）。「1 つの OAuth client id を 2 つのメールボックスで共有する」が**表現不能**になる（幻の third account が必ず生える）。代わりに決定 5 の明示的な検出を採る。
- **(f) alias ネスト cursor も今のうちに実装する** — 却下（決定 5）。対象 connector に cursor が存在せず、使われないコードを配ることになる。規約の宣言で十分。
