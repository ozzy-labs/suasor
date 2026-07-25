# 0047. Storage lifecycle（可視化先行 + opt-in retention、content-addressing は不採用）

- Status: Accepted（2026-07-25 承認）
- Date: 2026-07-25
- Deciders: Suasor maintainers
- Related: [ADR-0002](0002-event-sourced-architecture.md)（event log が正本・replay 不変性）, [ADR-0003](0003-local-first-and-content-minimization.md)（local-first・content minimization）, [ADR-0026](0026-source-forgetting.md)（redaction 機構 — 本 ADR が再利用する）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（trigram FTS）, [ADR-0006](0006-ml-delegation.md)
- Tracks: [#447](https://github.com/ozzy-labs/suasor/issues/447)（決定）

## Context

本文は **4 箇所**に分散して保存される:

| 保存先 | 対象 | 備考 |
| --- | --- | --- |
| `events.payload` | **全バージョン** | JSON 内に本文（`SourceObserved` / `SourceBodyUpdated`） |
| `sources.body` | 現行版 | projection |
| `sources_fts` | 現行版 | trigram 索引。本文より大きくなりやすい |
| `vec0` | 現行版 | embedding 有効時 |

[#447](https://github.com/ozzy-labs/suasor/issues/447) は最低 3 重保存を指摘し、対策として **content-addressed body store**（event schema の破壊変更）を挙げていた。

設計にあたって 2 つの事実が判明し、前提が変わった。

**① 肥大はまだ観測されていない。** 開発者のローカル store は 221KB・`events` 0 行である。成長の議論は現時点で**予測であって観測ではない**。

**② 本文を event ログから安全に落とす機構は既に存在する。** [ADR-0026](0026-source-forgetting.md) の `source.forget` が、`events.payload` の本文だけを redact しつつ replay 不変性を保つ経路を実装済みで、単一トランザクション化・`secure_delete`・WAL truncate まで入っている（ADR-0026 R1-1/4/5）。**retention が必要とする操作は、既に動いている。**

②により content-addressing の費用対効果は下がる。節約できるのは実質「現行本文 1 個ぶんの二重持ち」＋完全一致の重複排除（後者は sync の fingerprint スキップで既にほぼ効いている）で、対価は event schema の破壊変更と upcast である。

一方で、retention 自体に**本物の UX 代償**がある。古い本文を落とすと、その資料は全文検索から消える。秘書の価値の芯は「あの資料どこ」という長尾の想起なので、これは差別化を直接削る。さらに embedding は本文とは別に vec0 に残るため、**意味検索では見つかるのに本文が読めない**という状態が生まれ得る — 「見つからない」より体験として悪い。

## Decision

**まず内訳と成長を可視化する。retention は opt-in（既定 OFF）として定義し、既存の redaction 経路を再利用する。content-addressing は採用しない。**

### 決定 1: 可視化を先行させる（既定で有効・破壊なし）

- **`suasor store info`** — 本文がどこにどれだけあるかの内訳（`events` / `sources` / `sources_fts` / `vec0`）を出す。現在は総量しか出ていない
- **`doctor`** — store の成長率と、設定した上限への接近を警告する（[#442](https://github.com/ozzy-labs/suasor/issues/442) の `sync.freshness` と同じく、**尋ねなくても気づける**経路に置く）

**判断の材料を作ることを、判断の実行より先に置く。** 現時点で肥大は観測されておらず、可視化なしに retention を既定 ON にするのは「起きていない問題のために検索性を削る」ことになる。

### 決定 2: retention は opt-in・既定 OFF

```toml
[storage.retention]
bodyMaxAgeDays = 365   # 未設定なら何もしない
```

- 設定した場合のみ、期限より古い source の**本文だけ**を落とす
- **メタデータ・provenance link・embedding は残す** — 「いつ・誰から・何に繋がっていたか」は本文より桁違いに小さく、想起の足がかりとして最も効く
- 実装は [ADR-0026](0026-source-forgetting.md) の redaction 経路を再利用する（**event schema は不変**、replay 不変性も既に担保済み）
- 落とした本文は `source.list` / `source.get` で「retention により削除済み」と**明示**する。黙って空文字を返さない（[ADR-0007](0007-connector-contract.md) の "no silent wrong answer"）

embedding を残すことで生じる「意味検索では当たるが本文が無い」状態は、上記の明示で**説明可能な欠落**に変わる。何が起きたか分かる欠落は、原因不明の欠落とは別物である。

### 決定 3: content-addressed body store は採用しない

event payload から本文を外部 blob 表へ移す案は**却下**する。決定 2 が redaction 経路で成長を抑えられる以上、[ADR-0002](0002-event-sourced-architecture.md) の event schema を破壊し upcast を導入する対価に見合わない。

将来、実測で「同一本文の重複が支配的」と判明した場合は再検討の余地がある。**その判断のためのデータを作るのが決定 1** である。

### 決定 4: rebuild の streaming 化は設計判断ではなく実装課題

`rebuildProjections` は `readAllEvents` で**全 event を一度にメモリへ読む**（大きな store で OOM する）。これは設計上の選択肢ではなく単なる実装の欠陥なので、本 ADR の判断対象から外し、通常の実装 issue として扱う（カーソル反復への置換）。

## Consequences

### Positive

- **判断材料が先に手に入る** — 肥大が実際に起きるのか、どの層が支配的かを観測してから次を決められる
- retention が必要な人には道具があり、必要でない人の検索性は削られない
- event schema が不変なので、[ADR-0002](0002-event-sourced-architecture.md) の replay 不変性と既存 store の互換が保たれる
- 実装量が小さい — redaction 経路は既に本番品質（トランザクション・`secure_delete`・WAL truncate 済み）

### Negative / Trade-offs

- **重複保存は残る** — 4 箇所の構造は変わらない。opt-in を設定しない利用者の store は本文量に比例して伸び続ける
- retention を有効にすると、その範囲の全文検索は**恒久的に**失われる（event log からも消えるため復元できない。これは [ADR-0026](0026-source-forgetting.md) の forget と同じ性質）
- 「意味検索では当たるが本文が読めない」状態が発生し得る（明示はするが、体験としての違和感は残る）
- 成長率の警告閾値には根拠がなく、実測後の調整が要る

## Alternatives Considered

- **content-addressed body store を今決める** — 却下。決定 3 の通り、redaction で代替できる範囲に対して event schema 破壊の対価が大きい。データがほぼ空の今が破壊の最安値であるのは事実だが、**そもそも破壊が必要かどうかが未確認**の段階で払うべきコストではない
- **retention を既定 ON にする（例: 2 年）** — 却下。長尾の想起は差別化の芯であり、観測されていない肥大のために既定で削るのは順序が逆。加えて「いつの間にか資料が読めなくなっていた」は秘書として最悪の裏切り方をする
- **本文を落とさず圧縮する（payload の gzip 等）** — 見送り。効果はあるが、FTS 索引（多くの場合最大の層）には効かず、デバッグ時の可読性を失う。決定 1 の実測で「event payload が支配的」と出た場合に再検討する
- **可視化もせず様子を見る** — 却下。現在は `store info` が総量しか出さず、**内訳が見えないので判断のしようがない**。可視化は破壊なしで即日入れられる
