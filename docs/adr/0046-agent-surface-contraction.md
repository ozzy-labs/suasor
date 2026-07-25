# 0046. Agent surface の収縮（MCP tool 45 → 約 28 / skill 32 → 約 12）

- Status: Accepted（2026-07-25 承認）
- Date: 2026-07-25
- Deciders: Suasor maintainers
- Related: [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（read/write 境界と HITL — 収縮が跨いではならない線）, [ADR-0008](0008-assistant-skills.md)（skill カタログ）, [ADR-0032](0032-skill-frontmatter-schema.md)（frontmatter によるトリガ判定）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（検索 3 入口の由来）, [ADR-0045](0045-priority-ranking-model.md)（tier を増やさない構造への転換）
- Tracks: [#448](https://github.com/ozzy-labs/suasor/issues/448)（決定）

## Context

MCP tool は **45 本**（read 20 / write 25）、assistant skill は **32 本**（read 19 / write 13）。[#448](https://github.com/ozzy-labs/suasor/issues/448) が起票された時点では tool 40 本で、**その後も増え続けている**（直近では `sync.status` を追加した）。

表面積が問題なのは、**選択するのが人間ではないから**である。

**tool 側** — host LLM が毎回「正しい 1 本」を選ぶ。本数が増えるほど選択精度が落ち、カタログがコンテキストを食う。実際に選択を誤らせる重複が存在する:

- **検索が 3 入口**（`search` / `recall.search` / `search.hybrid`）— これは**検索アルゴリズムの選択をエージェントに押し付けている**。embedding が無効なのに `recall.search` を選んで degrade signal を処理する、有効なのに FTS を選んで取りこぼす、という失敗が構造的に起こる。ユーザーは「探して」としか言っていない
- **`source.get` と `source.get.full`** — 後者は前者 + provenance + 抽出。引数で足りるものが別 tool になっている
- **状態遷移が verb ごとに 1 本**（`commitment.resolve` / `.dismiss` / `.reopen`、`demand.ack` / `.dismiss`、`link.add` / `.remove`）— 同じ「状態を変える」操作が分裂している

**skill 側** — こちらは**ユーザーが自然文で発火させる**。ユーザーは skill 名を知らないまま話しかけるのに、同じ意図に複数の skill が並んでいる。最も深刻なのは「まとめて」クラスタで、`personal-brief` / `catchup` / `weekly-review` / `external-brief` / `health-check` の **5 本が「今週どうなってる」の一言で競合する**。違うのは期間・読み手・粒度という**パラメータ**だけである。同じ構図が「レビューして」（`doc-review` / `doc-diff` / `pr-review`）、「下書き作って」（`announcement-draft` / `handoff-draft` / `plan-draft` / `reply-draft`）にもある。

根本原因は共通で、**カタログが「ユーザーが何をしたいか」ではなく「我々が何を実装したか」の単位で並んでいる**ことにある。

## Decision

**同じ意図に対する入口を 1 本に畳み、違いは引数に逃がす。ただし read / write の承認境界は決して跨がない。**

### 決定 1: 畳んではならない線 — read / write 境界

MCP host は `readOnlyHint` を見て自動承認を判断し、skill は `readOnly` frontmatter で自律実行の可否が決まる（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md)）。**read と write を 1 本に統合すると、この境界が壊れる** — これまで承認不要だった読み取りが承認待ちになるか、write が自律実行されるかのどちらかで、どちらも許容できない。

収縮は**同じ承認クラス内でのみ**行う。これは以下すべての決定に優先する制約。

### 決定 2: MCP tool を 45 → 約 28 に畳む

| 現行 | 統合後 | 承認クラス |
| --- | --- | --- |
| `search` / `recall.search` / `search.hybrid` | `search { mode: "auto" \| "fts" \| "semantic" \| "hybrid" }` | read |
| `source.get` / `source.get.full` | `source.get { include?: ["links", "extraction"] }` | read |
| `commitment.resolve` / `.dismiss` / `.reopen` | `commitment.set { state }` | write |
| `demand.ack` / `demand.dismiss` | `demand.mark { state }` | write |
| `propose.apply` / `propose.reject` | `propose.decide { action }` | write |
| `link.add` / `link.remove` | `link.set { op }` | write |

`search` の既定は **`auto`** とする — embedding が有効なら hybrid、無効なら FTS。**「どの検索アルゴリズムか」はエージェントが判断すべきことではない**（degrade の signal は引き続き返し、host は結果の質を知れる）。

統合しないもの（意図が異なる）: `person.merge` / `person.split`（逆操作だが引数の形が違う）、`task.*` のライフサイクル（`create` / `update` / `publish` / `act` は行き先も副作用も異なる）、`source.forget` / `source.unforget`（不可逆性の重みが違い、1 本にすると誤爆が致命的）。

### 決定 3: skill を 32 → 約 12〜14 に畳む

「ユーザーが何をしたいか」で再編成し、違いは引数に逃がす:

| 現行クラスタ | 統合後 | 承認クラス |
| --- | --- | --- |
| `personal-brief` / `catchup` / `weekly-review` / `external-brief` / `health-check` | `brief { period, audience, format }` | read |
| `doc-review` / `doc-diff` / `pr-review` | `review { target }` | read |
| `find-document` / `research` | `find { depth }` | read |
| `meeting-prep` / `action-item-status` | `meeting { phase }` | read |
| `decision-log` / `decision-rationale` | `decisions { mode }` | read |
| `announcement-draft` / `handoff-draft` | `draft { kind }` | read |
| triage 系 4 本 | 2 本に集約 | write |

write skill は read 側と統合しない（決定 1）。`reply-draft` / `plan-draft` は write（HITL）なので read 側の `draft` とは別に残る。

### 決定 4: 追加の規律 — 足すなら畳む

**新しい top-level tool / skill を追加するときは、同時に既存を 1 本畳むか、なぜ畳めないかを PR に書く。** 45 本への到達は個々の判断が悪かったからではなく、「足す」判断だけがあって「畳む」判断が無かったからである。規律を置かない限り、収縮した直後から同じ成長が再開する。

[ADR-0045](0045-priority-ranking-model.md) が tier ラダーを項ベースのスコアへ変えたのは同じ問題への対処で、「signal を足しても構造が育たない」形への転換だった。

### 決定 5: 破壊的変更として一度に行う

tool 名・skill 名の変更は host 設定と 32 本の skill 本文の両方に波及する。**1.0 前の今が最も安い**ため、後方互換の alias を残さず一度に切り替える（[ADR-0042](0042-slack-workspace-less-connector.md) と同じ判断）。移行は `docs/guide/troubleshooting.md` の upgrade 節に機械的な対応表として載せる。

## Consequences

### Positive

- host の tool 選択精度が上がる（競合する説明文が消える）と同時に、カタログのコンテキスト消費が約 4 割減る
- 「探して」に対して**アルゴリズム選択をエージェントにさせない** — 一番よくある操作の一番よくある失敗が消える
- skill が「ユーザーが何をしたいか」の単位に揃い、「今週どうなってる」の 5 本競合が解消する
- 決定 4 の規律により、収縮が一度きりの掃除で終わらない

### Negative / Trade-offs

- **破壊的変更** — host 設定・skill 本文・docs の全面改訂が要る（alias は残さない）
- 「tool 選択ミス」が「enum 値の選択ミス」に移る。ただし後者は**呼び出し時に 1 つのスキーマを読んで決める**のに対し、前者は**カタログ上で複数の説明文が競合する**ため、精度は改善する見込み（実測で確認すべき仮説であることは認める）
- 統合された skill の SKILL.md は長く・条件分岐的になる（発火時に本文全体が読まれる）。代わりに description は全ての言い回しを 1 箇所に集約でき、トリガ判定は安定する
- 引数の既定値が「ほとんどの人にとって正しい」必要が出る（`search` の `auto` が典型）

## Alternatives Considered

- **明白な重複のみ畳む（検索 3→1 と `source.get` 2→1 だけ、45→42）** — 却下。破壊は小さいが本数がほぼ減らず、成長ペースを止める効果もない。同じ議論を数サイクル後にもう一度することになる
- **収縮せず規律だけ導入** — 却下。現状 45 本の選択精度問題は残ったまま、増加だけが止まる。既に競合している検索 3 入口は今日も誤選択を生んでいる
- **tool description の改善で選択精度を上げる** — 却下。説明文を厚くするほどカタログのコンテキスト消費が増え、競合の解消にもならない（3 つの良い説明文は依然 3 択である）
- **後方互換 alias を残して段階移行** — 却下。alias が残る限りカタログの本数は減らず、収縮の主目的（選択精度とコンテキスト）が達成されない。1.0 前に一度で切る
- **skill を統合せず本数のまま維持（markdown なのでコストは description のみ）** — 却下。コストの主体はトークンではなく**誤発火**である。ユーザーは skill 名を知らずに話しかけるので、重複したトリガは体験の問題として現れる
