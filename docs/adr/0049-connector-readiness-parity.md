# 0049. Per-connector readiness / drift parity（scope 層の上に到達性層を足し、drift Layer 1 を registry 上で一般化する）

- Status: Accepted
- Date: 2026-07-26
- Deciders: Suasor maintainers
- Related: [ADR-0007](0007-connector-contract.md)（connector 契約・no silent wrong answer — 本 ADR の判断基準）, [ADR-0011](0011-slack-operational-verbs-and-readiness.md)（scope readiness capability model — 本 ADR が「層」として明示化する）, [ADR-0030](0030-connector-discovery-verbs.md)（discovery registry — drift 一般化の載せ先。その Alternatives が per-connector 専用導線を却下した論理が本 ADR の根拠）, [ADR-0039](0039-conversation-discovery-drift.md)（Slack の三層 drift モデル — Layer 1 を本 ADR が一般化する）, [ADR-0048](0048-at-rest-protection.md)（doctor の「確信度が違うものを 1 行に畳まない」規律の先例）, [ADR-0003](0003-local-first-and-content-minimization.md)（明示列挙＝データ最小化 — drift の解が「自動追従」ではない理由）
- Tracks: [#478](https://github.com/ozzy-labs/suasor/issues/478)（#449 の次設計サイクル 3/3）/ [#529](https://github.com/ozzy-labs/suasor/issues/529) の minor `connectors/connector-4` を統合
- 一部改訂（2026-07-27・[#536](https://github.com/ozzy-labs/suasor/issues/536)・[ADR-0051](0051-ingest-scope-defaults.md)）: **決定 3 の google 例外（`driftNote` による `--new` 辞退）と Alternatives (h)（`calendarId` の配列化を却下）は覆された。** ADR-0051 が `calendarId` を `calendarIds` に複数化したので「configured な集合が無い」という辞退理由が消え、google は `scope = { key: "calendarIds" }` を宣言して drift 一般形に参加する。決定 3 の後半（Layer 2/3 を一般化しない理由）と、決定 1・決定 2 はそのまま有効。ms-graph の `user = "me"` を「probe が surface する footgun」と記した Consequences も、ADR-0051 決定 5 が既定値自体を撤去したことで**症状の記述**になった。

## Context

Slack connector は運用ハードニングが多層に積まれている: scope readiness（[ADR-0011](0011-slack-operational-verbs-and-readiness.md) の `FEATURE_SCOPES` capability model）/ doctor の Slack 固有検査 / discovery drift の三層モデル（[ADR-0039](0039-conversation-discovery-drift.md)）。非 Slack connector はこの水準に達していない。

**1. readiness が scope 層で頭打ちになっている。** Issue #194 の横展開で非 Slack にも `features:` block が入ったが、判定は **granted scope の部分一致**だけである（`src/connectors/auth-specs.ts` の `featureReadiness`）。granted scope は「その権限を**要求した**」ことしか言わない。とくに **ms-graph は scope 層で答えが出せない**: client-credentials の token は `scope: ".default"` しか返さず、application permission はサーバ側で解決されるため列挙されない。結果、ms-graph の readiness 行は**全部 `N/A (scopes not enumerated)`** である。google も scope は見えるが、実際に読む **`calendarId` が正しいか**は scope からは分からない — 打ち間違えた `calendarId` は全 scope 検査を通過してから静かに 0 件を取り込む（[ADR-0007](0007-connector-contract.md) の "no silent wrong answer" そのもの）。

**2. doctor の「enabled だが実質空」検査が非対称である。** doctor は scope 空（`connectors.noop`）と credential 不在（`connectors`）は汎用に見ているが、**非 secret の必須設定が空**の場合を見ていない。`clientId` / `tenantId` / `host` はいずれもスキーマ上 `.default("")` を持つ（zod v4 の `.default` は既定値を再検証しない）ため、`[connectors.google] enabled = true` だけの config が `loadConfig` も `validate-config` も `doctor` も通過し、**sync 時にベンダ側の不透明なエラーで初めて落ちる**。Slack には同じ層の検査（`slack.config` error）が既にある。

**3. discovery drift が Slack 専用のままである。** [ADR-0039](0039-conversation-discovery-drift.md) の三層モデル（`--new` diff / sync 時 sweep / doctor 検査）は Slack 専用に作られ、一般化の計画が無かった。しかし「**token からは見えているのに config に列挙されていない**」という穴の形は `DISCOVERY_SPECS` に載る全 connector で同一である（github の新 repo / notion の新 database / jira の新 project / box の新 folder）。しかも [ADR-0030](0030-connector-discovery-verbs.md) の Alternatives は per-connector の専用導線を「**connector ごとに専用導線を都度書くと drift する**」という理由で却下している — つまり **ADR-0030 自身の論理が、Slack 専用の drift モデルを弾劾している**。これは「検討事項」ではなく、採択済み方針との整合の問題である。

判断基準は #449 の freeze 決定から来る: **Slack を触らず、非 Slack を Slack の既存水準へ引き上げる**。Slack 固有の深掘りは freeze 対象なので、本 ADR は Slack 側に機能を足さない。

## Decision

### 決定 1. readiness は「scope 層」と「到達性層」の 2 層とし、畳まない

`<connector> auth test` に **per-resource reachability probe** を足す。configured な `resources` エントリごとに **read-only GET を 1 本**投げ、API が答えた事実を報告する。

- 判定語彙は 3 値で、**推測で ok と言わない**:
  - `REACHABLE` — 2xx。事実。
  - `UNREACHABLE` — 401/403（権限が無い）/ 404（configured な id がこの資格情報からは存在しない）。これも事実で、原因（permission か id か）を detail に書き分ける。
  - `UNKNOWN` — それ以外（transport 失敗・timeout・retry を生き延びた 5xx）。**`REACHABLE` に丸めない**。検証できていない前提こそ health check が surface すべきもの（[ADR-0048](0048-at-rest-protection.md) の `storage.disk_encryption` と同じ規律）。
- **`features:` block（scope 層）に畳まず、`resources (live probe):` として別 block で出す**。scope 行は「何が granted されたかの自己申告」、reachability 行は「API がこう答えた」であり、**確信度が違う**。1 行に畳むと弱い方が強い方の顔をして出てしまう。
- probe 先は **connector が実際に読む対象**にする。google calendar は汎用の calendar 一覧ではなく **configured な `calendarId`** を、ms-graph は **configured な `user`** 配下を読む。これにより「id の打ち間違い」が静かな 0 件取り込みではなく 404 として出る。
- 既定 ON・`--no-probe` で opt-out。「この資格情報で本当に動くのか」に答えるのが verb の存在意義であり、答える層を**明示的に要求しないと出ない**のは UX として倒錯している。コストは明示的な health コマンド上の cheap な GET 数本。
- onboard wizard 経路は probe しない（slice がまだ存在せず configured resource が無いため、probe すべき対象が無い）。

**scope 判定で十分か / 実到達 probe を足すかの整理（Issue の問い）への回答: 足す。** ms-graph は構造上 scope 層で答えが出ない（`.default`）ので、N/A を減らす手段は到達性 probe しか無い。google は scope が見えるが `calendarId` の正しさは scope の外にある。ただし **scope 層は残す**（消して到達性層に一本化しない）: 到達性は「今この瞬間読めた」しか言わず、scope は「そもそも何を許可したか」を言う。片方が他方を代替しないので、両方出す。

### 決定 2. doctor に「必須設定が空」検査を manifest 駆動で足す（Slack `slack.config` の非 Slack 対称形）

`ConnectorManifest.requiredSettings` を新設し、**その connector が無いと動かない非 secret 設定キー**を宣言する（google: `clientId` / ms-graph: `tenantId`・`clientId` / jira: `host`）。doctor は `connectors.config` として報告する。

- **severity は `error`**（warn ではない）。scope 空（`connectors.noop` = warn）とは失敗の形が違う: scope 空は「動いて 0 件」、必須設定空は「**API を名指しできず落ちる**」。Slack の対応検査（`slack.config`）も ADR-0042 決定 9 以来 error である。
- **`noopWarning` に畳まない**。両者は severity も対処も違い、独立に成立する（`resources = ["drive"]` は設定済みなのに `clientId` が空、という状態は普通にある）。
- 同じ判定を sync の pre-flight にも 1 行出す。exit code は変えない（実際の失敗は connector 側から来るので、この行が新たに失敗を**作る**ことはない）。
- manifest の completeness test が、宣言されたキーが**実在し、かつ空許容（`.default("")`）である**ことを検証する。スキーマが既に不在を弾くキーは `loadConfig` の担当であり doctor の担当ではない。

### 決定 3. drift は Layer 1 のみを registry 上で一般化し、Layer 2/3 は明示的に見送る

`DISCOVERY_SPECS` の各 spec に **`scope`（ingest 対象の id 集合が入る config キー）** を宣言させ、汎用 `<connector> <verb> --new` を [ADR-0039](0039-conversation-discovery-drift.md) Layer 1 の一般形として実装する。

- `--new` は **visible − configured**（新規）と、**configured − visible**（消失: rename/削除/権限喪失）を出す。**取り込まない・config に書かない**（[ADR-0039](0039-conversation-discovery-drift.md) の明示列挙＝データ最小化を維持。手 paste の一手間だけ削る）。
- **`--filter` / `--root` で絞った実行では「消失」を計算しない**。視野を狭めた列挙では「消えた」と「視野の外」を区別できず、区別できないものを断定するのは決定 1 と同じ罪である。「未チェック」と明示表示する。
- 比較は正規化して行う（既定 trim + lowercase）。notion だけ UUID のハイフン有無を吸収する（同じ database の表記違いは drift ではない）。
- **scope を持たない connector は `driftNote` で理由を宣言する**。google は `calendarId` が**単数**なので「configured な集合」が存在せず、集合差分を出すと選ばなかった全カレンダーが drift に見える。google 側で意味のある半分（configured な id がもう解決しない）は**決定 1 の到達性 probe が答える**ので、`--new` はその代替を名指しして拒否する。無言で機能が無い状態は ADR-0030 が警戒した drift そのものなので、宣言を必須にし test で強制する。

**Layer 2（sync 時 sweep）/ Layer 3（doctor 検査）を今回一般化しない理由:**

- Layer 1 は**一般化**である。「見えているもの」は registry が既に返しており、「設定されているもの」は config キーの宣言 1 行で足りる。新しい実行時コストも新しい config 表面も生まない。
- Layer 2 は一般化ではなく **connector ごとの新規コスト**である。cadence marker を各 connector の cursor に載せ、`discover_new` 相当の opt-out キーを各スキーマに足し、**毎 sync に列挙 API を 1 本増やす**必要がある。Slack がそれを負担するのは、チャンネル参加が日常的に起き、sync 自体が既に会話列挙をしているからである。github repos / notion databases / jira projects の drift 頻度は桁違いに低く、一方で discovery 呼び出しは「token から見える全件のページング列挙」（数千 repo もあり得る）で、sync 本体に対して相対的に小さいとは言えない。**コスト構造が Slack と違うので、Slack と同じ既定を配ってはいけない。**
- Layer 3（doctor）は Layer 2 の marker を読む設計なので、Layer 2 無しには**オフラインで成立しない**（doctor は診断であり自分では sweep しない、[ADR-0039](0039-conversation-discovery-drift.md) §Decision）。doctor を network 越しに sweep させるのは doctor の性格を変える別決定であり、本 ADR では採らない。したがって「doctor 検査だけで足りるか」への回答は **No — doctor 単独では成立しない。成立する最小単位は Layer 1 である**。
- 三層すべてを一度に配らないことで、Layer 2 の負担を払う価値がある connector が実データで判明してから、connector 単位で opt-in できる余地を残す。

## Consequences

### Positive

- ms-graph の readiness が「全部 N/A」から実際の判定に変わる。app-only の既定 `user = "me"`（app-only では解決できない）のような footgun が、空の sync ではなく `auth test` の 404 として出る。
- 打ち間違えた `calendarId` / `user` / 権限未付与が、sync を回して 0 件を目視するのではなく health verb で分かる（[ADR-0007](0007-connector-contract.md)）。
- `[connectors.google] enabled = true` だけの config が doctor で error として止まる。cron / CI が gate できる。
- 「見えているのに config に無い」が全 discovery connector で 1 コマンドになり、[ADR-0030](0030-connector-discovery-verbs.md) が却下したはずの per-connector 専用導線を増やさずに済む。
- 判定語彙が 3 値で固定され、`UNKNOWN` が `ok` に化けない。

### Negative / Trade-offs

- `auth test` の往復回数が「1 回」から「1 + configured resource 数」に増える（既定 ON）。明示的な health コマンド上のコストであり `--no-probe` で戻せるが、ゼロではない。
- 到達性 probe は**その瞬間**の事実しか言わない。probe 後に権限が変わればすぐ陳腐化する（scope 層を残す理由でもある）。
- `connectors.config` が error なので、**半端に設定した connector を放置している既存ユーザの doctor が exit 1 になる**。意図した挙動だが、初回は驚きになり得る。
- access token を auth leaf の戻り値に載せた（probe を駆動するため）。出力組み立ては field ごとに明示的で token を含まないが、**「戻り値に生 token がある」という新しい注意点**が増えた。
- drift Layer 2/3 が非 Slack に無いままなので、非 Slack の drift は**ユーザが `--new` を叩いたときにしか**分からない（Slack の「気づける」水準には届いていない）。これは決定 3 で意図的に受け入れたギャップである。

## Alternatives Considered

- **(a) scope 判定のままで N/A を許容する** — 却下。ms-graph は構造上 scope で答えが出ないので、「整理した結果 scope で十分」と書くことは **N/A を恒久化する**ことと同義になる。Issue #478 の「N/A 縮小」は達成されない。
- **(b) 到達性 probe に一本化し `features:` の scope 行を消す** — 却下。到達性は「今読めた」しか言わず、「そもそも何を許可したか」を失う。granted scope は再 consent の要否判断に必要で、probe が `UNKNOWN` のときは唯一残る情報でもある。
- **(c) scope 行と reachability 行を 1 行に統合する（`mail: READY (reachable)` 等）** — 却下。確信度の違う 2 つの主張を 1 行にすると、弱い方（自己申告）が強い方（API の応答）の権威を借りる。[ADR-0048](0048-at-rest-protection.md) が permissions と full-disk encryption を 2 行に分けたのと同じ理由。
- **(d) doctor で connector の資格情報を実際に叩いて検証する** — 見送り。doctor は原則オフライン（唯一の例外が embedding dim probe）で、全 connector 分の egress を毎 doctor で発生させるのは [ADR-0003](0003-local-first-and-content-minimization.md) の外部送信最小化と性格が合わない。生存確認は `auth test` の担当として残す。
- **(e) 必須設定検査を `noopWarning` に畳んで 1 本にする** — 却下。severity（warn / error）も対処も違い、独立に成立する状態がある。1 本にすると error 相当が warn に薄まるか、warn 相当が error に強まるかのどちらかになる。
- **(f) drift の三層すべてを一度に一般化する** — 却下。決定 3 の理由（Layer 2 は一般化ではなく per-connector の新規実行時コストで、Slack とコスト構造が違う）。
- **(g) `--new` に `--apply`（config 追記）を付ける** — 見送り。write は [ADR-0004](0004-mcp-agent-boundary-and-hitl.md) の HITL 対象で、[ADR-0039](0039-conversation-discovery-drift.md) Layer 3 も Slack 側で保留のままである。Slack より先に非 Slack で追記経路を作ると、一般化ではなく分岐を増やすことになる。
- **(h) google の `calendarId` を配列化して drift を集合差分にする** — 却下（本 Issue の範囲外）。ingest 対象の形を変える破壊的変更で、readiness / drift の話ではなく google connector の scope 設計の話である。
