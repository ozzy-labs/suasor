# Scheduling (periodic sync)

Suasor の中核価値は「散在した業務情報を手元に集める」こと。これを最新に保つには取り込み（`sync`）が定期的に走る必要がある。Suasor は**常駐デーモンを持たず**、定期実行を **OS のスケジューラ（cron / launchd / systemd timer）へ委譲**する（[ADR-0027](../adr/0027-bulk-sync-orchestration.md)）。取り込みは **read 専用**（[ADR-0003](../adr/0003-local-first-and-content-minimization.md) / [ADR-0004](../adr/0004-mcp-agent-boundary-and-hitl.md)）なので、自動化しても外部への書き込み・送信は発生せず HITL 原則を破らない。

## 一括取り込みコマンド `suasor sync`

`suasor sync` は**有効な connector を 1 回ずつ直列で取り込む**短命・冪等な one-shot コマンド（[ADR-0027](../adr/0027-bulk-sync-orchestration.md)・FR-ING-5/6）。有効判定は `connectors list` / `doctor` と同じ（`[connectors.<name>]` slice が存在し `enabled = false` でない）。コマンド・フラグの詳細は [CLI リファレンス](../design/cli.md) を参照。

```bash
suasor sync                                  # 有効 connector を一括取り込み
suasor sync --connector github,slack         # 対象を絞り込む
suasor sync --json                           # 件数・cursor・エラーを JSON でログ化
```

要点（スケジューリングで効いてくる性質）:

- **冪等**: 各 connector は fingerprint / cursor で差分検知する（[FR-ING-3](../requirements/functional.md)）ため、同一データの再実行は event を重複させない。重複起動しても壊れない
- **continue-on-error**: 1 connector の失敗（token 切れ等）が全体を止めない。**1 つでも失敗すれば exit 1**（`doctor` と同じ終了コード規約）。スケジューラ側はこの終了コードで失敗を検知できる
- **短命**: 全 connector を 1 回回して終了する。プロセスを保持しない（常駐しない）

事前に `suasor doctor` で config・DB・資格情報が揃っているか確認しておくと、スケジュール実行前の取りこぼしを防げる。

## cron（Linux / macOS）

`crontab -e` に追記する。`suasor` が PATH にある前提（無ければ絶対パスで指定）。

```cron
# 毎時 15 分に一括取り込み。stdout/stderr をログに残す。
15 * * * * suasor sync --json >> "$HOME/.local/state/suasor/sync.log" 2>&1
```

多重起動を避けるなら `flock` で排他する（前回の実行が長引いても重複起動しない）:

```cron
15 * * * * flock -n /tmp/suasor-sync.lock suasor sync --json >> "$HOME/.local/state/suasor/sync.log" 2>&1
```

`suasor sync` は冪等なので重複起動しても安全だが、`flock` は無駄な並行実行（API rate limit 消費）を抑える。

## launchd（macOS）

`~/Library/LaunchAgents/com.suasor.sync.plist` を作成する。`StartInterval` は秒。`suasor` の絶対パスを使う（launchd は最小 PATH で起動する）。

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.suasor.sync</string>
    <key>ProgramArguments</key>
    <array>
      <string>/usr/local/bin/suasor</string>
      <string>sync</string>
      <string>--json</string>
    </array>
    <key>StartInterval</key>
    <integer>3600</integer>
    <key>StandardOutPath</key>
    <string>/Users/USERNAME/Library/Logs/suasor-sync.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/USERNAME/Library/Logs/suasor-sync.log</string>
  </dict>
</plist>
```

読み込み・起動:

```bash
launchctl load ~/Library/LaunchAgents/com.suasor.sync.plist
launchctl start com.suasor.sync   # 動作確認のため即時実行
```

## systemd timer（Linux）

user unit として配置する（`~/.config/systemd/user/`）。systemd は失敗（exit 1）を `failed` 状態として記録し、`OnFailure=` で通知 unit に繋げられる。

`suasor-sync.service`:

```ini
[Unit]
Description=Suasor bulk connector sync (one-shot)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/suasor sync --json
```

`suasor-sync.timer`:

```ini
[Unit]
Description=Run Suasor sync hourly

[Timer]
OnCalendar=hourly
Persistent=true

[Install]
WantedBy=timers.target
```

有効化:

```bash
systemctl --user daemon-reload
systemctl --user enable --now suasor-sync.timer
systemctl --user list-timers suasor-sync.timer   # 次回実行を確認
journalctl --user -u suasor-sync.service          # ログを確認
```

`Persistent=true` はマシンが停止していて取りこぼした実行を起動後に補う。`oneshot` + `exit 1` で `systemctl --user status suasor-sync.service` が失敗を表面化する。

## 終了コードと監視

`suasor sync` は **1 つでも connector が失敗すると exit 1**（`doctor` と同じ規約）。スケジューラ側でこの終了コードを監視に使う:

- cron: 失敗時にメール / 通知（`MAILTO=` や wrapper script で exit code 分岐）
- systemd: `OnFailure=` で通知 unit を起動
- `--json` 出力をログに残し、`failed` 件数や connector ごとの `error` を後追いできるようにする

`--json` の形は connector ごとの結果（`{ connector, ok, outcome?, error? }`）と集計（`succeeded` / `failed`）を含む（[CLI リファレンス](../design/cli.md) の `BulkSyncResult`）。

**部分失敗も exit 1 で検知できる**（[ADR-0014](../adr/0014-slack-multi-workspace.md) / [#166](https://github.com/ozzy-labs/suasor/issues/166)）: Slack のマルチ workspace のように 1 connector が内部に複数の取り込み単位（workspace）を持つ場合、**一部の workspace だけが失敗した部分失敗**も connector 失敗として集計され `suasor sync` 全体が exit 1 になる（取り込めた workspace のレコードは保持される）。`slack sync` 単体でも同様に部分失敗で exit 1 となり、末尾に workspace 別サマリ行を出す。これにより「一部 workspace だけ token 切れ / rate limit」を exit code を gate にした cron / CI で取りこぼさない（従来は「全 workspace 失敗時のみ exit 1」で部分失敗が exit 0 に隠れていた）。`--json` では各 connector の `outcome.partialFailure` / `outcome.summaryLines` で機械可読に判別できる。

## 鮮度の確認 `suasor sync status`

スケジューラに定期実行を委譲すると「最後にいつ sync できたか」「直近の run は成功したか」をスケジューラのログ越しに追う必要が出る。`suasor sync status` は connector 別の**最新 sync run**（最終 sync 時刻 / 取り込み件数 / 直近の成否 / 所要時間）を手元から直接確認できる（[ADR-0033](../adr/0033-sync-run-history.md)）。

```bash
suasor sync status            # connector 別の最終 sync 時刻 / 件数 / 成否を表示
suasor sync status --json     # 機械可読（cron 監視・ダッシュボード連携向け）
```

sync の実行履歴は `SyncRunStarted` / `SyncRunEnded` event として追記され、`sync_runs` projection に畳まれる。**connector が throw した失敗 run も `status=error` で残る**ため、`suasor sync` 全体の exit code（前節）に加えて「どの connector の直近 sync が・いつ・なぜ失敗したか」を後追いできる。次回予定（next run）は OS スケジューラ側の責務のため表示しない（鮮度は「最終 sync からの経過」で判断する）。有効だが未 sync の connector は `never synced` と表示される。

## なぜ常駐デーモンにしないのか

常駐 `--watch` は多重起動ロック・クラッシュ復旧・再起動管理という複雑性を持ち込む。Suasor は single-user / local-first 前提でこの種の調整機構を意図的に持たない（[ADR-0020](../adr/0020-multi-actor-coordination-scope.md)）。OS スケジューラは既にこれらを解決しているので、定期実行はそちらに委譲する（[ADR-0027](../adr/0027-bulk-sync-orchestration.md)）。`brief`（期間ダイジェスト）も同じく cron / CI 前提で設計されており、運用モデルは一貫している（[ADR-0017](../adr/0017-brief-period-bundle.md)）。
