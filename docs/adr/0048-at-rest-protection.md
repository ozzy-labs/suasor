# 0048. At-rest protection（平文ストアの脅威モデルと境界）

- Status: Accepted（2026-07-26 承認）
- Date: 2026-07-26
- Deciders: Suasor maintainers
- Related: [ADR-0003](0003-local-first-and-content-minimization.md)（local-first・本 ADR が「プライベート」の意味を確定させる）, [ADR-0001](0001-typescript-bun-stack.md)（`bun:sqlite` 固定 = SQLCipher が使えない制約）, [ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)（FTS-first = 本文暗号化と両立しない）, [ADR-0026](0026-source-forgetting.md)（crypto-shredding を 1 行で却下していた唯一の言及）, [ADR-0007](0007-connector-contract.md)（no silent wrong answer）, [ADR-0047](0047-storage-lifecycle.md)（retention・保持量の制御）
- Tracks: [#529](https://github.com/ozzy-labs/suasor/issues/529)（ADR 敵対的検証 `system/privacy-1`）

## Context

Suasor は個人の業務文脈の全体 — Slack DM・メール本文・カレンダー・ドキュメント抽出テキスト — を**1 つの平文 SQLite ファイル**に集約する。集約それ自体が製品の価値（[ADR-0003](0003-local-first-and-content-minimization.md)）だが、同時に**単一の高価値ターゲット**を作る。

にもかかわらず、**at-rest 保護をどの ADR も検討していなかった**。唯一の言及は [ADR-0026](0026-source-forgetting.md) の「crypto-shredding — 却下（現状 over-engineering）」という 1 行で、これは forget の実装手段としての却下であって、**保護方針の検討ではない**。

検証して 2 つのことが分かった。

**1. 「プライベートストア」が成立していなかった。** DB はプロセスの umask で作られており、一般的な環境では `0644` — **同一マシンの任意のユーザーが全文を読める**。`-wal` サイドカーも同様で、こちらは直近に書かれたページを verbatim に保持する。バックアップ（`VACUUM INTO` / `tgz`）も同じだった。[ADR-0003](0003-local-first-and-content-minimization.md) は「手元の**プライベート**ストアに保持」と書いていたが、その語は裏付けを持っていなかった。

**2. アプリレベル暗号化は選択肢として実質的に閉じている。**

- **SQLCipher は使えない** — `bun:sqlite` は素の SQLite（3.50.4）で、`PRAGMA key` は**黙って受理され何もしない**（`cipher_version` は `null`）。採用は [ADR-0001](0001-typescript-bun-stack.md) の基盤再選定 + sqlite-vec 拡張の再解決を意味する
- **本文だけの暗号化は FTS-first を捨てることと同義** — 暗号文に FTS5 の索引は張れない（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md) は中核不変条件）
- **現実の脅威（ノート PC の盗難・紛失）は OS のフルディスク暗号化が覆う** — FileVault / BitLocker / LUKS。アプリの外側で、すでに広く運用されている

## Decision

**アプリ内で暗号化は行わない。守る範囲を明文化し、ファイル権限で「同一マシンの他ユーザー」を実際に締め出し、「ディスクが機械を離れた後」は OS のフルディスク暗号化に委ねる。前提に置く以上、`doctor` がその前提を検証する。**

### 決定 1: 脅威モデルを明示する

| 脅威 | 守られるか | 何が守るか |
| --- | --- | --- |
| 同一マシンの**他ユーザー**がストアを読む | **守られる** | ファイル権限 `0600` / ディレクトリ `0700`（決定 2） |
| **プロセス外への意図しない送信** | **守られる** | [ADR-0003](0003-local-first-and-content-minimization.md) / NFR-PRV-1・3、egress は embedding / extraction サイドカーのみで既定 loopback |
| ソースへの**書き戻し** | **守られる** | connector は read 専用（[ADR-0007](0007-connector-contract.md)） |
| **盗難・紛失したディスク**からの読み出し | **守られない（Suasor 単体では）** | OS のフルディスク暗号化（決定 3） |
| **ユーザー自身のアカウントを奪取した攻撃者** | **守られない** | 同一 uid で動く以上、いかなるアプリ内暗号化でも守れない（鍵に到達できる） |
| バックアップの持ち出し先での保護 | **守られない** | 持ち出し先の暗号化。バックアップは権限のみ継承（決定 2） |

最後から 2 番目の行が、アプリ内暗号化を追求しない理由の中核である。**Suasor はユーザーの uid で動く。** 鍵を OS keychain に置いても、そのユーザーとして実行できる攻撃者は同じ経路で鍵を取れる。アプリ内暗号化が実際に足すのは「**ディスクが機械を離れた後**」の防御だけで、それは FDE がすでに、より広く（DB だけでなくシステム全体を）覆っている。

### 決定 2: ストアと関連ファイルを owner-only にする

Suasor が作るファイルは**作成のたびに**所有者のみに制限する（`0600`）、ディレクトリは `0700`:

- DB 本体・**`-wal` / `-shm` サイドカー** — WAL は直近に書かれたページを verbatim に保持するので、ここを開けたままにすると**最も新しい取り込み内容**が漏れる
- config ディレクトリ・`config.toml`
- バックアップ出力（`VACUUM INTO` の単一ファイルと `tgz` アーカイブの**両方**。後者は `tar` が書くので別途締める）

`init` 時だけでなく **`openDatabase` のたび**に適用する。DB は最初に開いたコマンドが作るのであり、これにより**本 ADR 以前に作られたストアも、次にコマンドを実行した時点で自動的に是正される**（移行手順を要求しない）。

権限付与は best-effort で、失敗しても Suasor を止めない（Unix mode を持たないファイルシステム上のストアが起動不能になってはならない）。**黙って成功したことにはしない** — `doctor` が実際の on-disk mode を読み返して報告する。Windows では `chmod` が read-only ビットにしか対応しないため、**保証を主張せず** NTFS ACL と FDE に委ねる旨を報告する。

### 決定 3: FDE は前提とし、前提である以上 `doctor` が検証する

「OS のフルディスク暗号化に委ねる」と書いて終わりにすると、**誰も検証しない前提**になる。これは [NFR-PRV-3](../requirements/non-functional.md) の旧版（保証できないことを SHOULD で約束していた）と同じ失敗である。

したがって `doctor` は 2 つを**別々のチェックとして**報告する。確信度が違うものを 1 行に畳まないためである:

- **`storage.permissions`** — on-disk mode を読み返した**事実**。他ユーザーから読めれば WARN と是正コマンド
- **`storage.disk_encryption`** — **best-effort**。macOS は `fdesetup status`、Windows は `manage-bde -status` で判定する。**Linux は `unknown` と答える**

Linux を推測しないのは、LUKS / LVM-on-LUKS / ZFS native / eCryptfs / ベンダー実装のどれもが該当し、**信頼に足る単一の判定手段が無い**ため。推測した `ok` は「守られている」と誤って伝える（[ADR-0007](0007-connector-contract.md) の "no silent wrong answer"）。`unknown` は手動確認 1 回のコストで済む。同じ理由で、**プローブの失敗は `off` ではなく `unknown`** とする — コマンドが動かなかったことは、ディスクが暗号化されていない証拠ではない。

`unknown` は **`ok` ではなく `warn`** で出す。本 ADR が FDE を前提に置いた以上、未検証の前提こそ可視化すべきものである。

### 決定 4: 保持量を減らすことも at-rest 対策である（既存機能への接続）

暗号化しない代わりに、**そこに無いものは漏れない**。[ADR-0047](0047-storage-lifecycle.md) の retention（`[storage].retention.bodyMaxAgeDays`）と [ADR-0026](0026-source-forgetting.md) の `source.forget` は、機能としては storage / privacy 由来だが、**at-rest 露出面の削減手段でもある**。両者は既に `secure_delete` + `wal_checkpoint(TRUNCATE)` で解放ページを消しており、削除が bytes-on-disk まで届く。

## Consequences

### Positive

- [ADR-0003](0003-local-first-and-content-minimization.md) の「プライベートストア」が**実際に真になる**（共有マシンでの読み取りが塞がれる）
- 何から守られていて**何から守られていないか**が 1 箇所に書かれ、ユーザーが自分の環境に応じた判断をできる
- 前提（FDE）が検証されるので、「ADR には書いたが誰も有効にしていない」状態が可視化される
- FTS-first（[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md)）も `bun:sqlite`（[ADR-0001](0001-typescript-bun-stack.md)）も崩さない

### Negative / Trade-offs

- **盗難ディスクに対して Suasor 単体では無防備**であることを明示的に受け入れる。FDE を有効にしていないユーザーは保護されない
- Linux で FDE を有効にしていても `doctor` は `unknown` と言う（誤検知より誤陰性を選んだ帰結。WARN が 1 行残り続ける）
- Windows では権限による保証を主張できない
- 権限の締め上げは、同一ストアを**複数 OS ユーザーで共有**する使い方を壊す（そのような使い方は元々 [ADR-0003](0003-local-first-and-content-minimization.md) の想定外）

## Alternatives Considered

- **SQLCipher でストア全体を暗号化** — 却下（現時点）。[ADR-0001](0001-typescript-bun-stack.md) の `bun:sqlite` を離れ、sqlite-vec 拡張のロードを再解決する基盤工事になる。得られるのは FDE がすでに覆う範囲であり、**同一 uid の攻撃者には無力**（鍵に到達できる）。FDE を持たない環境が主要な利用形態になった時に再考する
- **`sources.body` のみ列単位で暗号化** — 却下。暗号文に FTS5 の索引を張れず、[ADR-0005](0005-fts-first-retrieval-embedding-sidecar.md) の FTS-first を破棄することと同義。検索できない秘書に価値は無い
- **`PRAGMA key` を設定して暗号化した気になる** — 却下（というより**不可**）。素の SQLite は未知の pragma を**黙って無視**するため、これは何もせずエラーも出さない。本 ADR がこの事実を明記するのは、外部の SQLite 情報を読んで設定しようとする利用者を止めるため
- **鍵を OS keychain に置いてアプリ内暗号化** — 却下。secrets（[NFR-PRV-4](../requirements/non-functional.md)）と違い、本文の復号は**常駐 MCP server が読むたびに**必要で、鍵はプロセス内に常在する。同一 uid の攻撃者に対する防御にならず、脅威モデル上の追加は FDE と重複する
- **何もしない（現状維持）** — 却下。「プライベートストア」を名乗りながら world-readable なのは記述と実装の乖離であり、脅威モデルが書かれていないこと自体が本 finding の指摘だった
