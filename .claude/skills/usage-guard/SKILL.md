---
name: usage-guard
description: Claude Code の Usage Limit（5 時間 = Current / 週次 = Weekly）を監視し、95% 超過で作業を一時停止、リセットで枠が回復したら自動再開する pause/resume エンジン。drive 等の caller が checkpoint で Read するエンジン形態と、`/usage-guard "<継続コマンド>"` で任意作業を guard する単体形態を同梱。Claude 専用（OAuth 使用率エンドポイント + ScheduleWakeup 依存）。
adapters: claude-code
user-invocable: true
argument-hint: "<継続コマンド>（空欄で status 確認のみ）"
disable-model-invocation: true
---

# usage-guard - Usage Limit pause/resume エンジン

Claude Code の Usage Limit が 100% に達するとセッションが中断される。本スキルは 100% 手前（既定 95%）で作業を一時停止し、リセットで枠が回復したら自動再開する仕組みを提供する。

> **Claude 専用**: OAuth 使用率エンドポイント（`~/.claude/.credentials.json` のトークン）と `ScheduleWakeup` に依存するため、`adapters: claude-code` で gate している（Codex / Gemini / Copilot には配信しない）。
>
> **自己完結ドキュメント**: 本 SKILL.md は他ファイル（`.agents/skills/...` の canonical）を Read しない。gate により codex adapter の `.agents/` 出力が存在しないため、本体手順をすべてここに内包している。

## シグナル取得: usage-check スクリプト

判定の決定論部分は `usage-check.mjs` が担う。skill ディレクトリ直下に同梱され、user-scope では `~/.claude/skills/usage-guard/usage-check.mjs`、dogfood では `.claude/skills/usage-guard/usage-check.mjs` に置かれる。**実行時は本 SKILL.md と同じディレクトリの `usage-check.mjs`** を Bash で実行する:

```bash
node ~/.claude/skills/usage-guard/usage-check.mjs
```

> dogfood（skills/commons リポ内）で動かす場合はリポルートの `.claude/skills/usage-guard/usage-check.mjs` を実行する。どちらの環境でも「本 SKILL.md と同じ階層の `usage-check.mjs`」を指す。

## 環境要件（endpoint 経路が使えること）

`usage-check.mjs` の**正規の判定経路は OAuth 使用率エンドポイント**（`source: "endpoint"`）。これを使うには、スクリプトを実行する Bash に次の 2 つが許可されている必要がある:

- **(a) api.anthropic.com への egress**: `GET https://api.anthropic.com/api/oauth/usage` を叩く。ハーネスの sandbox / network 許可でこのホストへの送信が**ブロックされていると endpoint 経路が落ちる**。
- **(b) `~/.claude/.credentials.json` の読み取り**: `claudeAiOauth.accessToken` を毎回読む。permissions allowlist でこのファイル読みが許可されていないと token を得られず endpoint 経路が落ちる。

**許可しないとどうなるか**: endpoint が落ちると JSONL フォールバック（粗い推定）→ 最悪 **fail-open**（`source: "fail-open"`・`ok: true`）に縮退し、**ガードが事実上 OFF のまま気づかず進行**しうる。実運用で、Bash からの当該リクエストが sandbox / 権限ゲートで一貫して deny され endpoint が使えなかった事例がある。

**許可方法**:

- network: ハーネスの設定で `api.anthropic.com` への egress を許可する（sandbox を使う場合はこのホストを allowlist に追加）。
- permissions: settings の permissions allowlist に `~/.claude/.credentials.json` の Read と、`usage-check.mjs` を起動する `node` 実行を許可エントリとして追加する。
- 設定後は `node .../usage-check.mjs` を 1 回叩き、出力 JSON の `"source"` が **`endpoint`**（または直後 TTL 内なら `cache`）になることを確認する。`jsonl` / `fail-open` のままなら上記 (a)(b) のどちらかがまだブロックされている。

> **fail-open は劣化シグナル**: `source !== "endpoint"`（特に `fail-open`）のとき、wait-loop / 単体形態 / PreToolUse hook は**劣化警告**を出す（allow は維持）。drive caller はこの劣化をレポートに残すこと（「⚠️ usage-guard 劣化: source=fail-open、実際には監視していません」）。

### 振る舞い

- `~/.claude/.credentials.json` の `claudeAiOauth.accessToken` を**毎回読み直す**（`expiresAt` 失効を考慮）
- `GET https://api.anthropic.com/api/oauth/usage`（ヘッダ `Authorization: Bearer` / `anthropic-beta: oauth-2025-04-20` / `User-Agent: claude-code/<version>`）で `five_hour` / `seven_day` の `utilization` と `resets_at` を 1 回で取得
- 30–60s のローカルキャッシュ（`~/.claude/usage-guard/cache.json`、`.claude/skills/` 配下に置かない）で連打を防止。`#123` の PreToolUse hook と同じキャッシュを共有する
- endpoint 失敗時は `~/.claude/projects/*/*.jsonl` の per-message `usage` + timestamp から 5h / 7d window を推定する JSONL フォールバック
- endpoint と JSONL の**両方が失敗したら fail-open**（`ok: true`）+ stderr に警告（ガードが自バグで hard-stop しない）
- 超過時の `wait_seconds` には**ポストリセットのバッファ**（既定 +300 秒）を加算する。サーバ側 `utilization` 反映の遅延・ScheduleWakeup の発火ブレを吸収し、リセット丁度に絞られた枠へ再突入して再ハネするのを防ぐ（後述「閾値」「振る舞い: 再開バッファ」）
- **反映ラグ検知**（`suspected_reflection_lag`）: リセット直後はサーバ側 `utilization` が**前枠の残像**を返すことがある（リセット済みなのに 5h util 100% 等）。超過枠が**境界直後**（枠開始からの経過 `elapsed = period - (resets_at - now)` が epsilon=900 秒未満）なら矛盾とみなし、`wait_seconds` を full-window ではなく**短い再チェック間隔**（既定 180 秒）に切り替える。この結果は cache に書かない（後述「振る舞い: 反映ラグ検知」）

### 出力 JSON

```json
{
  "five_hour": { "utilization": 0, "resets_at": "..." },
  "seven_day": { "utilization": 0, "resets_at": "..." },
  "ok": true,
  "wait_seconds": 0,
  "resets_at": null,
  "resume_buffer_seconds": 300,
  "suspected_reflection_lag": false,
  "source": "endpoint"
}
```

- `ok`: **両枠の `utilization` が閾値未満**なら `true`
- `wait_seconds`: 超過枠の `resets_at` の**最遅**（最も遅くリセットする枠）までの秒数 **+ `resume_buffer_seconds`**。`ok` のときは `0`。**`suspected_reflection_lag` が `true` のときは**短い再チェック間隔（`USAGE_GUARD_LAG_RECHECK_SECONDS`、既定 180 秒）に縮退する
- `resets_at`: その最遅の超過枠の `resets_at`（**枠端のまま不変**。バッファ加算も lag 縮退もしない）。`ok` のときは `null`。再開予定 = `resets_at + resume_buffer_seconds` として区別できる
- `resume_buffer_seconds`: `wait_seconds` に折り込まれたポストリセットのバッファ秒数（既定 300、0 で従来挙動）
- `suspected_reflection_lag`: 反映ラグ（境界直後なのに超過）の疑いなら `true`。`true` のとき `wait_seconds` は短い再チェック間隔になり、この結果は **cache に書かれない**（次チェックが endpoint 実値を即取得できる）。`ok` のときは常に `false`。endpoint / jsonl 両経路でセットされる
- `source`: `endpoint` / `jsonl` / `cache` / `fail-open`

### 振る舞い: 再開バッファ

超過検知時、`wait_seconds` に `resume_buffer_seconds`（既定 300 秒）を加算する。これにより待機は `resets_at`（枠端）ではなく `resets_at + buffer` まで延び、リセット直後のサーバ反映遅延を回避して一発でクリーンに新枠へ再突入できる（実運用で「reset + 数分」で綺麗に再開できた）。

- `resets_at` は**枠端のまま変えない**。再開予定時刻は `resets_at + resume_buffer_seconds` で表す
- `ok`（未超過）時はバッファを加算しない（`wait_seconds: 0`）
- PreToolUse hook の deny ヒント（「あと N 分」）も `wait_seconds` 由来なのでバッファ込みで提示され整合する

### 振る舞い: 反映ラグ検知（境界直後の偽陰性回避）

リセット直後はサーバ側 `utilization` が**前枠の残像**を引きずることがある（例: 5h 枠が 21:00 にリセット済みなのに 21:05 の endpoint が util 100% を返し、`resets_at` は既に次境界 02:00 を指す矛盾状態）。この状態をそのまま扱うと「回復済みの枠を ~5h 無駄に放置」する偽陰性になる。`resume_buffer`（#129）は「reset 未到来」前提の対策でこのケースには効かない。

判定原理: 超過枠ごとに **枠開始からの経過** `elapsed = period - (resets_at - now)`（`five_hour` の period = 18000 秒、`seven_day` = 604800 秒）を算出する。`elapsed` が epsilon（`USAGE_GUARD_LAG_EPSILON_SECONDS`、既定 900 秒）未満かつ超過なら**矛盾** → 反映ラグの疑いとして `suspected_reflection_lag = true` をセットする。

- lag 疑い時は `wait_seconds` を full-window+buffer ではなく**短い再チェック間隔**（`USAGE_GUARD_LAG_RECHECK_SECONDS`、既定 180 秒）にする。caller は長時間 CronCreate を境界に張らず、この短間隔で再 fetch すればラグ解消後の実値を拾える
- `resets_at` は**枠端のまま不変**（情報を捨てない）
- lag 疑いの結果は **cache に書かない**（前枠の偽 100% が TTL 間 cache に固定されて再チェックを潰すのを防ぐ。次チェックは endpoint 実値を即取得する）
- `ok`（閾値未満）のときは lag 判定せず常に `suspected_reflection_lag: false`

### 閾値

既定 95%。環境変数 `USAGE_GUARD_THRESHOLD` で上書き可能（例 `USAGE_GUARD_THRESHOLD=80`）。

ポストリセットの再開バッファは既定 300 秒。環境変数 `USAGE_GUARD_RESUME_BUFFER_SECONDS` で上書き可能（例 `USAGE_GUARD_RESUME_BUFFER_SECONDS=600`）。`0` で従来挙動（`resets_at` 丁度に再開）に戻せる。負値・非数値は既定 300 にフォールバックする。

反映ラグ検知の閾値も env で上書きできる:

- `USAGE_GUARD_LAG_EPSILON_SECONDS`（既定 900）: 境界直後とみなす経過秒数。これより `elapsed` が小さい超過枠を lag 疑いとする。負値・非数値・空は既定 900 にフォールバック
- `USAGE_GUARD_LAG_RECHECK_SECONDS`（既定 180）: lag 疑い時の短い再チェック間隔。`0` 以下・非数値・空は既定 180 にフォールバック（busy-loop 防止）

## 軽量 wait-loop（共通ロジック）

両形態が共有する停止/再開の中核:

1. `usage-check.mjs` を実行して JSON を得る
2. **劣化チェック**: `source !== "endpoint"`（`cache` は endpoint 由来なので除外）なら劣化警告を出す。特に `source === "fail-open"` のときは「⚠️ usage-guard 劣化: source=fail-open、実際には監視していません」を**呼び出し側・ユーザーに明示**し、drive caller はレポートに残す（allow / 進行は維持。§環境要件 を案内）
3. `ok` なら**通常進行**（継続コマンドを実行 / caller は次の checkpoint へ）
4. `ok` が `false` なら再開トリガを選び（下記「再開トリガの選択」）、**待機する**
   - **反映ラグ疑い時（`suspected_reflection_lag: true`）は短間隔で再チェック**する。`wait_seconds` は既に短い再チェック間隔（既定 180 秒）に縮退しているので、境界に長時間 CronCreate one-shot を張らず、`ScheduleWakeup(wait_seconds)` 等でこの短間隔だけ待って再び `usage-check.mjs` を叩く。ラグが解消すれば次チェックで実値（多くは `ok: true`）を拾い継続できる（前枠残像のまま ~5h 放置する偽陰性を回避）
   - 通常の超過時は `wait_seconds` に `resume_buffer_seconds`（既定 300）が折り込まれているので、待機は `resets_at + buffer` まで延びる
   - **待機中は再入しない**（予算を一切消費しない）
5. 起床したら再び `usage-check.mjs` を実行し、`ok` になるまで 2〜5 を繰り返す（lag 疑いの結果は cache に書かれないので、再チェックは endpoint 実値を即取得する）
6. `ok` になったら継続コマンドへ進む

> `wait_seconds` は `resets_at`（+ buffer）から算出するため秒精度ではない。ScheduleWakeup の発火も下限 + オーバーヘッドで多少遅れる（実機で 60s 要求に対し ~110s）。reset 待ちには十分な精度。

### 再開トリガの選択

待機後の再開（heartbeat / 起床）には 2 つの機構がある。状況で使い分ける:

| 状況 | 再開トリガ |
|---|---|
| /loop dynamic・in-session・待機 **≤1h** | `ScheduleWakeup(min(wait_seconds, 3600))`。1 回上限 3600s。`wait_seconds` が長ければ複数回に分けて再チェックする |
| 非 /loop オーケストレーション（Agent tool / Workflow drive）・待機 **>1h**・再起動耐性が必要 | `CronCreate`（`recurring: false`, durable）を **`resets_at + resume_buffer_seconds`** にセットし、発火時に継続コマンドを再投入する |

- **ScheduleWakeup**: in-session の heartbeat 向き。1 回最大 3600s なので長い待機は多段になる。`wait_seconds > 3600` のときは `min(wait_seconds, 3600)` を繰り返す。
- **CronCreate one-shot**: 壁時計で一発・再起動耐性あり。`>3600s` かつ非 /loop（Agent tool orchestration 等）で堅牢。発火時刻は `resets_at + resume_buffer_seconds`（= `wait_seconds` 由来の再開予定）に合わせる。one-shot（`recurring: false`）は**発火後 auto-delete** される。実運用では ~72 分待機を Agent tool orchestration で回した際、ScheduleWakeup 多段より CronCreate one-shot の方が堅牢だった。

## 利用形態 1: エンジン形態（呼び出し側が Read）

drive（#122）等の caller が **resumable unit の境界（checkpoint）** で本 SKILL.md を Read し、上記 wait-loop を実行する。

### checkpoint 規約

- 停止は**常にクリーンに再入できる境界**で行う。mid-implement（PR 作成前など）では止めない
- caller は各 unit の**入口**で usage-check を実行し、`ok` でなければ wait-loop に入る
- 継続コマンドは **caller が供給**する。drive は冪等 resume（既存 PR を検出して Phase 3 から再開）なので、待機後の再実行をそのまま再開機構に流用する（例: `/drive <args>` ── drive の usage-guard は既定 ON のため継続コマンドに `--usage-guard` を付けない）
- drive のオーケストレーションモードでは wave 境界の粒度で呼ぶ。走行中の worker 内の超過は `#123` の PreToolUse hook が mid-unit ceiling として捕捉する

## 利用形態 2: 単体形態 `/usage-guard "<継続コマンド>"`

drive 非依存で、任意の長い作業を auto pause/resume で guard する（user-invocable）。

### 引数

- `$ARGUMENTS` を**継続コマンド**として解釈する
- **空欄なら status 確認のみ**: `usage-check.mjs` を実行して現在の `five_hour` / `seven_day` の `utilization` と `ok` / `wait_seconds` を表示して終了する

### 手順

1. `usage-check.mjs` を実行する
2. **劣化チェック**: `source !== "endpoint"`（`cache` を除く）なら劣化警告をユーザーに出す。`fail-open` のときは「実際には監視していません」と明示する（進行は維持。§環境要件 を案内）
3. **両枠 `ok`** なら、継続コマンドを実行する（通常進行）
4. **超過**なら:
   - 再開トリガを選ぶ（§軽量 wait-loop「再開トリガの選択」）。in-session で待機 ≤1h なら `ScheduleWakeup(min(wait_seconds, 3600))`、>1h・非 /loop なら `CronCreate`（`recurring: false`）を `resets_at + resume_buffer_seconds` にセットして待機する（待機中は再入しない。`wait_seconds` はバッファ込み）
   - 起床（回復検知）したら **`/usage-guard "<継続コマンド>"` を自己再入**する
   - `ok` になるまで heartbeat を繰り返し、`ok` で継続コマンドを実行する

### 継続コマンドの冪等性

継続コマンドは**冪等前提**で扱う。待機を挟んで再実行されても安全であること（重複副作用を生まない / 進捗を検出して途中から再開できる）がユーザーの責任。

- drive は元来冪等（既存 PR / ブランチを検出して再開）なので、`/usage-guard "/drive #123"` のように安全に巻ける（drive の usage-guard は既定 ON）
- 汎用の長い作業（ビルド・バッチ等）を巻く場合は、再実行で壊れない設計か自分で確認すること

### 実行例

```text
/usage-guard "/drive #123"
/usage-guard ""                 # status 確認のみ
USAGE_GUARD_THRESHOLD=80 /usage-guard "<継続コマンド>"   # 閾値を一時的に 80% へ
USAGE_GUARD_RESUME_BUFFER_SECONDS=600 /usage-guard "<継続コマンド>"   # 再開バッファを 10 分へ
```

## PreToolUse hook を有効化（推奨併用）

本スキルの停止粒度は resumable unit の境界。drive の usage-guard checkpoint（#122、#130 で既定 ON）は unit 境界でしか止められないのに対し、PreToolUse hook（`usage-guard-hook.mjs`）は **全 tool 呼び出し前**に効く mid-unit ceiling で、長い unit の途中で閾値を超えてもその場で止める。両者は役割分担して併用する:

| 仕組み | 粒度 | 止まる場所 |
|---|---|---|
| drive usage-guard checkpoint（#122 / #130 既定 ON） | resumable unit 境界 | Phase 入口 / wave 入口 / worker dispatch 前など、クリーンに再入できる checkpoint |
| PreToolUse hook（本節） | tool 呼び出し単位（subagent 内含む） | unit の途中（in-flight ceiling） |

> hook はまず `usage-check.mjs` が書いた**同じキャッシュ**（`~/.claude/usage-guard/cache.json`、30–60s TTL）を読む。hot cache ならそれを返すだけなので全 tool 呼び出しで連打しない。**cold/stale のときは hook 自身が `getUsage`（cache-first）に落ちて 1 回だけ endpoint を叩き、その結果をキャッシュに書き戻す（self-sustaining）**。`getUsage` は fs を注入しない caller でも実 fs で cache を書くため、usage-check.mjs が事前に走っていなくても単体運用で TTL 内 1 回の fetch に収束する（cache を温め続けるのは hook 経路自身）。閾値超なら deny（exit 2）+ `resets_at` を `HH:MM` で提示、usage を読めなければ fail-open（allow + stderr 警告）。subagent 由来の呼び出しは payload の `agent_id` でログ上区別する。
>
> **劣化可視化**: usage の `source` が `endpoint` / `cache` 以外（特に `fail-open`）のとき、hook は allow を維持しつつ stderr に劣化警告を出す（「⚠️ usage-guard DEGRADED: source=fail-open …」）。endpoint 経路が使えていない＝ガードが事実上 OFF の状態を見逃さないため。原因と許可方法は §環境要件 を参照。

### 仕組みと配置

hook 本体は extra file として skill ディレクトリ直下に同梱される（`usage-check.mjs` と同経路）。本リポは settings/hook を**配信しない**（build は skill / agent のみ出力）ため、有効化は**手動 opt-in**。

### settings.local.json スニペット（`update-config` 方式）

`~/.claude/settings.local.json` に PreToolUse hook を 1 つ追加する（settings は mid-session reload されるため再起動不要）:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /home/<you>/.claude/skills/usage-guard/usage-guard-hook.mjs"
          }
        ]
      }
    ]
  }
}
```

> **M3: hook スクリプトパスは絶対パスを手で埋める。** settings 内では skill-dir 相対参照が効かないため `command` には**絶対パス**を書く。パスは環境で揺れる:
>
> - **user-scope**（`npx @ozzylabs/skills install` で配置）: `~/.claude/skills/usage-guard/usage-guard-hook.mjs`（`~` は展開されないので `/home/<you>/.claude/...` の形でフルに書く）
> - **dogfood**（skills/commons リポ内で動かす）: `<repo>/.claude/skills/usage-guard/usage-guard-hook.mjs`（例 `/home/<you>/github/ozzy-labs/skills/.claude/skills/usage-guard/usage-guard-hook.mjs`）
>
> どちらも「`usage-check.mjs` と同じ階層の `usage-guard-hook.mjs`」を指す。自分の環境のフルパスを確認してから埋めること。閾値を上書きする場合は env も settings 側に付ける（例 `"command": "USAGE_GUARD_THRESHOLD=80 node /home/<you>/.claude/skills/usage-guard/usage-guard-hook.mjs"`）。

### 無効化

`~/.claude/settings.local.json` から上記 PreToolUse エントリを削除すれば即時に無効化される（mid-session reload）。

## 注意事項

- ガードは**自バグで hard-stop しない**: シグナル取得が全滅したら fail-open で作業を継続する（`source: "fail-open"` + stderr 警告）
- ただし **fail-open はガードが OFF の状態**。`source !== "endpoint"` のとき各形態は劣化警告を出すので、見かけたら §環境要件 で endpoint 経路を復旧すること
- 待機中は予算を消費しない（再入しない・heartbeat のみ）
- 待機後の再開は `resets_at + resume_buffer_seconds`（既定 +5 分）まで延びる。リセット丁度に絞られた枠へ再突入して再ハネするのを防ぐため
- 長い待機は live セッションで吸収する前提（WSL + 常時起動）。>1h・非 /loop では CronCreate one-shot（durable）が堅牢（§軽量 wait-loop）
