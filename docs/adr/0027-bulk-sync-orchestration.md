# 0027. bulk sync orchestration & scheduling delegation

- Status: Accepted
- Date: 2026-06-20
- Deciders: Suasor maintainers
- Related: [ADR-0003](0003-local-first-and-content-minimization.md)（取り込みは read 専用）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（HITL）, [ADR-0007](0007-connector-contract.md)（connector 契約）, [ADR-0020](0020-multi-actor-coordination-scope.md)（single-user 前提で session/handoff/lock を drop した単純性）
- Tracks: #146

## Context

現状、取り込みは connector ごとに手動実行する（`suasor <connector> sync`、[ADR-0007](0007-connector-contract.md)）。Suasor の中核価値である「散在した業務情報を手元に集める」は、定期的に sync が走らないと常に古くなる。複数 connector を有効化しているほど、1 つずつ手で叩く負担が大きい。

取り込みは **read 専用**（[ADR-0003](0003-local-first-and-content-minimization.md) / [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)）なので、一括化・定期化しても外部への書き込み・送信は発生せず、HITL 原則を破らない。よって安全に自動化できる領域である。

核心の緊張は「定期実行をどう実現するか」。素朴には常駐デーモン（`--watch`）が考えられるが、[ADR-0020](0020-multi-actor-coordination-scope.md) は single-user 前提で session / handoff / lock / agent-run / workspace を**意図的に drop**して単純性を選んでいる。常駐プロセスは多重起動ロック・クラッシュ復旧・再起動管理という、まさに ADR-0020 が避けた複雑性を再導入する。

既存の `suasor brief` CLI も「対話エージェント不在の定期実行（cron / CI）向けに非対話で stdout 出力する」と明記済みで、**スケジューリングは OS 側に委ねる**前提が既にある（[ADR-0017](0017-brief-period-bundle.md)）。一括 sync もこの一貫した方針に乗せるべき。

## Decision

**一括 sync は短命・冪等な one-shot コマンド `suasor sync` として提供する。定期実行は Suasor の責務とせず、OS スケジューラ（cron / launchd / systemd timer）へ委譲する。常駐 `--watch` は採らない（将来必要になれば別 ADR に隔離する）。**

1. **`suasor sync` は config の有効 connector を列挙して直列に sync する。** 有効判定は `connectors list` / `doctor` と同一規約 —`[connectors.<name>]` slice が存在し `enabled = false` でない connector。connector 実装の lazy import は維持する（[ADR-0007](0007-connector-contract.md) import-clean、NFR-PRF-1）。各 connector の取り込み本体は既存の共有 `syncConnector` サービスを呼ぶ（CLI 単体 sync・`connector.sync` MCP tool と同一コードパス）。

2. **continue-on-error。** 1 connector の失敗が全体を止めない。各 connector の成否を集計し、**1 つでも失敗があれば exit 1**（`doctor` の終了コード規約に合わせ、cron / CI が gate に使える）。`--continue-on-error` フラグで明示制御するが、既定でも他 connector の完了は妨げない方針とする（部分的に集まる方が「集める」価値に資する）。

3. **`--connector a,b` で対象を絞り込める。** 指定された名前のうち、有効かつ登録済みのものだけを対象にする。

4. **`--json` で機械可読出力。** connector ごとの件数（`SyncOutcome`）・cursor・エラーを集約した結果を JSON で出す（cron のログ化・監視向け）。

5. **冪等・短命。** 各 connector の sync は fingerprint / cursor で差分検知する（[ADR-0007](0007-connector-contract.md) FR-ING-3）ため、同一データでの再実行は event を重複 append しない。`suasor sync` は全 connector を 1 回ずつ回して終了する one-shot で、プロセスを保持しない。

6. **定期実行は OS スケジューラに委譲。** cron / launchd / systemd timer から `suasor sync` を呼ぶ範型を [docs/guide/scheduling.md](../guide/scheduling.md) に示す。多重起動防止・失敗通知・ログ管理は OS スケジューラの既存機構（`flock`、systemd の `OnFailure`、timer の `Persistent` 等）に任せる。

## Consequences

### Positive

- 単一コマンドで全有効 connector を取り込める。中核価値（情報を集める）の鮮度を低コストで保てる
- 取り込みは read 専用のままなので、自動化・定期化しても HITL を破らない（外部送信ゼロ）
- 常駐デーモンを持たないことで、多重起動ロック・クラッシュ復旧・再起動管理の複雑性を回避（[ADR-0020](0020-multi-actor-coordination-scope.md) の単純性を維持）
- スケジューリングを OS に委譲することで、`brief` と一貫した運用モデルになる（cron / CI 前提）
- continue-on-error + exit code 規約で、一部 connector の token 切れ等があっても他は完了し、監視で検知できる

### Negative / Trade-offs

- 「常に最新」は OS スケジューラの設定責任になる（Suasor 単体では定期実行しない）。セットアップに 1 ステップ追加される（ガイドで吸収）
- 直列実行のため、connector 数 × 各取り込み時間だけかかる（並列化は将来の最適化余地。現状は単純性優先）
- `--watch` を望む声には別 ADR を要する（意図的に scope 外）

## Alternatives Considered

- **常駐デーモン（`suasor sync --watch`）** — 却下。多重起動ロック・クラッシュ復旧・再起動という [ADR-0020](0020-multi-actor-coordination-scope.md) が意図的に避けた複雑性を再導入する。single-user / local-first には過剰
- **connector ごとの個別 cron エントリ（一括コマンドを作らない）** — 却下。connector を増やすたび cron 設定が増え、全体の成否集約・exit code 規約を運用者が自前で組む必要がある。一括コマンド + continue-on-error の方が単純
- **並列 sync** — 現時点では却下（直列で十分・単純）。rate limit 制御や進捗集約の複雑性に見合わない。将来ボトルネックになれば別途検討
- **fail-fast（最初の失敗で停止）** — 却下を既定とする。一部でも集まる方が価値に資するため continue-on-error を既定にし、exit code で失敗を通知する
