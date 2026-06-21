---
description: Issue または指示から実装・PR 作成・セルフレビュー・修正を自動で回し、merge-ready な PR を出す。単一/複数の Issue/PR と明示依存記法に対応。オプションでマージまで実行可能。
argument-hint: <#N | #N,#N | #N-N | instruction> [--merge] [--concurrency N] [--review=quick|final-deep|deep] [--no-usage-guard]
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, AskUserQuestion, Agent, Workflow
---

# drive

`.agents/skills/drive/SKILL.md` を Read し、ワークフロー手順に従う。

**重要:** 各フェーズでは対応するスキルの SKILL.md を Read して**ワークフロー手順のみ**を実行する。読み込んだ SKILL.md 内の「次のアクション提案」セクションおよび「完了報告」セクションは**すべて無視**する。フェーズ間の遷移は本スキルが制御する。

## Claude Code 固有の追加事項

### 入力解析

`$ARGUMENTS` を解析し、target リスト（Issue/PR/指示）と依存記法、オプション（`--merge`, `--concurrency N`, `--review=<mode>`, `--no-usage-guard`）を特定する。

- target が 1 件かつ依存記法（`->`）なし → 単一モード
- target が 2 件以上、または依存記法あり → オーケストレーションモード

`--review` の取り扱い:

- 既定は `quick`
- 単一モード: `quick` / `final-deep` / `deep` をすべて受け付ける
- オーケストレーションモード: `--review=quick` を強制し、`final-deep` / `deep` 指定時は警告を表示して `quick` にフォールバックする（コスト管理）

usage-guard の取り扱い:

- **既定で有効（opt-out）**。明示的に `--no-usage-guard` を付けたときのみ checkpoint を挟まない素の drive を実行する。
- `--no-usage-guard` 未指定なら、後述「usage-guard 配線（既定 ON・`--no-usage-guard` で無効化）」の checkpoint で usage-guard エンジンを呼び、Usage Limit 超過時は枠回復まで待機してから自己再入する。
- `--usage-guard` は後方互換の **deprecated no-op エイリアス**として受理する（既定 ON のため明示は不要・挙動は既定と同一）。継続コマンドには強制付与しない。
- 解析時に**元の引数列を保存**する（継続コマンド `/drive <元の引数>` の組み立てに使う）。`--no-usage-guard` がユーザー指定されていた場合のみ保存対象に含めて継続コマンドにも引き継ぐ。`--usage-guard` は no-op エイリアスなので保存・付与しない。

### 自律実行

計画承認を含め、マージ処理（またはマージ確認）まで AskUserQuestion を使用しない（完全自律実行）。

### usage-guard 配線（既定 ON・`--no-usage-guard` で無効化）

**既定で有効**。Claude Code の Usage Limit（5 時間 = Current / 週次 = Weekly）が 100% に達する前に作業を一時停止し、枠が回復したら自動再開する。**`--no-usage-guard` 指定時のみ本節の処理を一切実行せず、drive 本体の挙動を変えない**（pause/resume は Claude 固有なので配線を本 overlay に閉じる。前例: `review --deep`）。`--usage-guard` は deprecated no-op エイリアスとして受理するが、既定で有効なため挙動は変わらない。

> **Claude 専用**: usage-guard エンジンは OAuth 使用率エンドポイントと `ScheduleWakeup` に依存するため Claude Code でのみ動作する（`adapters: claude-code` で gate された `usage-guard` skill = #121）。base SKILL.md は既定 ON だが、他アダプタ（codex/gemini/copilot）のビルド出力には本 overlay が含まれないため実効は no-op。

#### graceful degrade（skill 不在）

既定 ON のため、usage-guard skill / `usage-check.mjs` が**存在しない環境**（例: `~/.claude/skills/usage-guard/` 未配置）でも drive を**エラーで止めない**。各 checkpoint の冒頭で `usage-guard` skill（`.claude/skills/usage-guard/SKILL.md`、user-scope では `~/.claude/skills/usage-guard/SKILL.md`）の存在を確認し、**不在を検出したら 1 行警告**（例: 「⚠️ usage-guard 劣化: skill 未インストール、監視せず通常進行します」）**を出してそのまま通常進行する**（fail-open 扱い・以降の checkpoint も skip）。これはデフォルト ON の必須要件であり、guard が自不在で drive を hard-stop させない。

#### checkpoint の発火点

`--no-usage-guard` 未指定（= 既定 ON）のとき、以下の **resumable unit の入口**でのみ usage-guard を呼ぶ:

| モード | checkpoint |
|---|---|
| 単一モード | 各 target の **Phase 1（implement）開始前** |
| 単一モード | **review loop の各反復前**（Phase 3 の各 pass 開始前） |
| オーケストレーション | 各 **wave の開始前**（Phase 1..N の wave ループ先頭） |
| オーケストレーション | 各 **worker dispatch 前**（同一 wave 内で worker を起動する直前） |

**checkpoint は常にクリーンに再入できる境界に置く**。mid-implement（PR がまだ存在しない実装途中）や review pass の途中、コミット/push の途中では**止めない** — そこで停止すると再入時に進捗を取りこぼす恐れがある。drive は冪等 resume（既存 PR を検出して Phase 3 から再開）なので、上記の境界はいずれも再実行で安全に続きから再開できる。

#### checkpoint での手順

各 checkpoint で以下を実行する:

1. `usage-guard` エンジン（`.claude/skills/usage-guard/SKILL.md`、user-scope では `~/.claude/skills/usage-guard/SKILL.md`）を Read し、その「軽量 wait-loop」を実行する（= 同階層の `usage-check.mjs` を Bash 実行して JSON を得る）。
2. `ok: true`（両枠とも閾値未満）→ **通常進行**。次のフェーズ／wave／worker dispatch へそのまま進む。
3. `ok: false`（いずれかの枠が閾値超過）→ usage-guard の wait-loop に委譲する。`wait_seconds` にはポストリセットのバッファ（`resume_buffer_seconds`、既定 +300 秒）が折り込まれており、待機は `resets_at + buffer` まで延びる（リセット丁度の再突入による再ハネを回避）:
   - in-session・待機 ≤1h → `ScheduleWakeup(min(wait_seconds, 3600))` で heartbeat を仕込み、**待機する**（待機中は再入せず予算を消費しない）。`wait_seconds` が 3600 を超える場合は複数回に分けて再チェックする。
   - 非 /loop オーケストレーション（Agent tool / Workflow drive）・待機 >1h・再起動耐性が必要 → `CronCreate`（`recurring: false`, durable）を **`resets_at + resume_buffer_seconds`** にセットし、発火時に継続コマンドを再投入する（壁時計一発・再起動耐性。one-shot は発火後 auto-delete）。既定 ON によりこの経路（>1h・非 /loop）を踏みやすいため、該当時は `ScheduleWakeup` ではなく **`CronCreate`(one-shot, durable)** を優先する。詳細は usage-guard SKILL.md §軽量 wait-loop「再開トリガの選択」。
   - **反映ラグ疑い時（`suspected_reflection_lag: true`）は境界に長時間 CronCreate を張らず、短間隔（`wait_seconds` ≈ 180 秒）で `ScheduleWakeup` 再チェック**する（境界直後の前枠残像による偽 100% を回復確認後に拾い、~5h 放置の偽陰性を回避。usage-guard SKILL.md §振る舞い: 反映ラグ検知 を参照）。
   - 起床したら継続コマンド **`/drive <元の引数>`** を自己再入する（既定 ON のため `--usage-guard` を強制付与しない。`--no-usage-guard` がユーザー指定されていた場合のみ引き継ぐ ── ただし `--no-usage-guard` 時はそもそも本節を実行しないため、実際の継続コマンドは元の引数をそのまま渡せばよい）。drive の冪等 resume が既存 PR / ブランチ / 完了済み worker を検出して**続きから再開**する（待機を挟んでも重複副作用を生まない）。
   - `usage-check.mjs` が `ok: true` を返すまで 3〜4 を繰り返す。

> 継続コマンドには**元の引数列**をそのまま渡す（既定 ON のため `--usage-guard` の付与は不要。resume 後も guard は既定で効き続ける）。

#### 粒度と二重化

- orchestration の停止は **wave 境界 / worker dispatch 境界の粒度**。一度起動した worker の**走行中（mid-unit）の超過**はこのフラグでは止められない。長い unit 内の ceiling は #123 の **PreToolUse hook**（全 tool 呼び出し前に効き、subagent 内にも届く）が担う（推奨併用）。一過性異常値で hook が誤 deny し session が hard-stop した場合は **`touch ~/.claude/usage-guard/DISABLE`** で即解除できる（#139、usage-guard SKILL.md §無効化）。
- worker（subagent）に渡す prompt 自体は無改変でよい。worker は単一モードを実行するため、**親が（既定 ON で）worker dispatch 前に checkpoint を挟む**ことで wave 粒度の予算対応になる。

#### fail-open（劣化可視化）

usage-check のシグナル取得が全滅（endpoint → JSONL フォールバックともに失敗）した場合、usage-guard は `ok: true`（fail-open）を返す。drive はそのまま通常進行する — **ガードが自バグで drive を hard-stop させない**。

ただし fail-open は**ガードが事実上 OFF**の状態。checkpoint で得た JSON の `source` が `endpoint` / `cache` 以外（特に `fail-open`）のとき、drive caller は**劣化を明示報告に残す**（例: 「⚠️ usage-guard 劣化: source=fail-open、実際には監視していません」）。endpoint 経路が使えていない原因（api.anthropic.com egress / `~/.claude/.credentials.json` 読み取りの権限）と復旧方法は usage-guard SKILL.md §環境要件 を参照。走行中 worker の PreToolUse hook も同様に劣化警告を stderr に出す。

### オーケストレーション実行機構の選択

オーケストレーションモードの worker 並列実行には 2 つの機構がある。**Workflow tool が利用可能なら Workflow 方式を優先**し、利用不可（dynamic workflows 無効環境・旧バージョン）なら従来の Agent tool 方式（「subagent dispatch」節）に fallback する。

| | Workflow 方式 | Agent tool 方式 |
|---|---|---|
| 並列制御 | ランタイムが cap・キュー管理 | 手動 semaphore |
| worktree 隔離 | `isolation: 'worktree'` | `isolation: "worktree"` |
| 戻り値検証 | `schema` で構造化検証（不一致は自動リトライ） | JSON 自由記述を親が parse |
| 進捗監視 | `/workflows` UI + `log()` | `gh pr list` polling |
| 中断再開 | `resumeFromRunId`（完了 worker はキャッシュ復元） | 手動再実行 |

### Workflow 方式によるオーケストレーション（推奨）

Phase 0（DAG / wave 構築）と計画表示は**Workflow 起動前に会話側で**行う（workflow はミッドランのユーザー入力を受けられないため、承認系はすべて起動前後に置く）。wave 構成を `args` で渡し、以下の形のスクリプトを組む:

```js
export const meta = {
  name: 'drive-orchestration',
  description: 'drive: wave 単位で worker を並列実行し merge-ready PR 群を作る',
  phases: [{ title: 'Wave 1' }, { title: 'Wave 2' }],  // 実際の wave 数に合わせて起動時に書く（pure literal）
}

// canonical（.agents/skills/drive/SKILL.md）の戻り値 JSON contract を JSON Schema 化したもの
const WORKER_SCHEMA = { /* target / title / branch / pr_url / pr_number / status / review / cross_cutting_gaps / final_head_state / error */ }

const results = []
const failed = new Set()
for (const [i, wave] of args.waves.entries()) {
  // 依存元が failed の target は dispatch せず skipped 扱いにする（canonical の失敗 semantics）
  const runnable = wave.filter(t => !t.deps?.some(d => failed.has(d)))
  wave.filter(t => !runnable.includes(t)).forEach(t => {
    results.push({ target: t.target, status: 'skipped', error: `upstream failed: ${t.deps.join(',')}` })
    log(`${t.target} skipped (upstream failed)`)
  })
  // --concurrency N がランタイム cap より小さい場合は runnable を N 件ずつのスライスに割って直列に流す
  const waveResults = await parallel(runnable.map(t => () =>
    agent(workerPrompt(t), { label: t.target, phase: `Wave ${i + 1}`, isolation: 'worktree', schema: WORKER_SCHEMA })
  ))
  for (const r of waveResults) {
    if (!r) continue
    results.push(r)
    if (r.status === 'failed') failed.add(r.target)
    log(`${r.target} → ${r.pr_url ?? '-'} (${r.status})`)
  }
}
return { results }
```

`workerPrompt(t)` には以下を必ず含める（Agent tool 方式の「subagent dispatch」と同一の制約。ランタイムの worktree 隔離は cleanup を肩代わりするが、worker の git 操作自体は防がないため prompt 制約は省略不可）:

- canonical SKILL.md を Read して単一モード Phase 1-5 を実行する指示
- main / 親側 ref への書き込み禁止コマンド一覧
- Edit / Write tool の `file_path` 制約（自 worktree path 限定）
- `--delete-branch` 禁止
- ベースブランチ規則（依存元 wave の有無で分岐）
- 戻り値 JSON contract（`final_head_state` / `cross_cutting_gaps` 含む）

Workflow 方式固有の注意:

- **スクリプト内で `Date.now()` / `Math.random()` / 引数なし `new Date()` は使えない**（resume 決定性のためランタイムが throw する）。タイムスタンプが必要なら `args` で渡す
- 観測性は `/workflows` UI と `log()` が担う。Agent tool 方式の `gh pr list` polling は不要
- wave 間の `await` は依存関係による**意図的バリア**（pipeline 化しない）
- workflow 内 worker は `acceptEdits` 固定でセッションの allowlist を継承する。長時間 run で permission prompt が出ないよう、必要コマンドが allowlist にあることを起動前に確認する
- 途中失敗からの再開は `Workflow({scriptPath, resumeFromRunId})`。完了済み worker はキャッシュから復元される
- **Phase Final-1 / Final-2 / Final-3 は workflow 終了後に会話側で実行する**。worker の worktree は変更を含むためランタイムの自動削除対象にならず、cleanup 手順（後述の Phase Final-2 節）が引き続き必要。worktree path 規約（`.claude/worktrees/agent-<id>/`）も同一
- `--merge` 未指定時の一括マージ確認（「完了後」節の AskUserQuestion）は workflow の return 後に行う
- **wave checkpoint は会話側で挟む**（既定 ON。`--no-usage-guard` 指定時は省略）。workflow スクリプトは決定論実行で SKILL.md の Read も `ScheduleWakeup` も呼べないため、wave 単位で workflow を起動し、各 wave の起動**前**に会話側で「usage-guard 配線」節の checkpoint を実行する（`ok` なら次 wave の workflow を起動、超過なら待機 → `/drive <元の引数>` で再入し、`resumeFromRunId` で完了済み worker をキャッシュ復元して続行）

### subagent dispatch（オーケストレーションモード・Agent tool 方式 fallback）

オーケストレーションモードでは `Agent` tool で各 target を並列実行する:

- **isolation:** `"worktree"`（必須）
- **subagent_type:** `general-purpose`
- **prompt:** subagent から slash command は呼べないため、`.agents/skills/drive/SKILL.md` を Read させ、target #N について単一モードのワークフロー（Phase 1-5）を実行するよう指示する。`--merge` 指定時は Phase 4 まで完了し、自 PR の merged まで polling して終了させる。最終結果は JSON で返させる
- **main / 親側 ref への書き込み禁止（必ず prompt に明記）:** subagent は自 worktree branch で完結する。以下のコマンドは全て**禁止** — 親 worktree の `HEAD` / `index` / `refs/heads/main` を共有 git directory 経由で汚染する ([Issue #66](https://github.com/ozzy-labs/skills/issues/66) / [Issue #89](https://github.com/ozzy-labs/skills/issues/89))。worktree は親側で削除されるため main へ戻す必要はない:
  - `git checkout main` / `git switch main` / `git checkout HEAD~` (HEAD 移動)
  - `git symbolic-ref HEAD refs/heads/main` (HEAD を符号的に main へ切替)
  - `git update-ref refs/heads/main <sha>` (main ref を直接書き換え)
  - `git reset --hard origin/main` (自 branch が main を指す状態で実行すると間接的に親に伝播)
  - `git branch -m <new-name>` (worktree-branch binding を壊す)
  - `git push origin main` / `git push origin HEAD:main`
- **戻り値 JSON に `final_head_state` を必須化（必ず prompt に明記）:** subagent 完了時、自 worktree の `git symbolic-ref HEAD` / `git rev-parse HEAD` / `git status --short` 出力を戻り値 JSON の `final_head_state` フィールドに含める。`symbolic_ref` が `refs/heads/main` または空（detached）なら親側 Phase Final-1 で warning。これは「main checkout なし」の自己申告と実態が乖離した観察 ([Issue #89](https://github.com/ozzy-labs/skills/issues/89)) への対策で、self-attestation を検証可能にする
- **Edit / Write tool の `file_path` 制約（必ず prompt に明記）:** subagent の Edit / Write tool に渡す `file_path` は必ず自 worktree path（`.claude/worktrees/agent-<id>/`）で始まる absolute path に限定する。親 worktree path（repo root 直下で `.claude/worktrees/` を含まない path）を渡してはならない。Phase 20 (opshub) で観察した汚染は **`cd` ではなく Edit/Write の絶対 path 引数経由**で発生したため、本制約が決定的。実行前に `pwd` で自 worktree path を確認してから tool に渡すと安全（[Issue #77](https://github.com/ozzy-labs/skills/issues/77)）
- **`--delete-branch` 禁止（必ず prompt に明記）:** subagent が auto-merge をセットする際、`gh pr merge --auto --squash` までに留め、`--delete-branch` は付けない。自 worktree が握る branch を削除しようとして `fatal: '<branch>' is already used by worktree at ...` エラーになる。ローカル branch / worktree の整理は親側 Phase Final で一括処理する（[Issue #69](https://github.com/ozzy-labs/skills/issues/69)）
- **scope 外波及チェック（必ず prompt に明記）:** subagent が enum / field / CLI flag を追加した場合、リポ全体で対応する help 文字列・エラーメッセージ・サンプル/docs を grep し、同期を確認する。同期されていなければ可能なら自 PR に含める。自 scope を明確に超える場合は戻り値 JSON の `cross_cutting_gaps: string[]` フィールドに `<file>:<line> — <symbol> not synced` 形式で記録し、親の Phase Final-3 audit に集約する（[Issue #70](https://github.com/ozzy-labs/skills/issues/70)）
- **依存元 wave がある場合のベースブランチ:**
  - `--merge` 指定 + 依存元が merged → main から作成
  - `--merge` 指定 + 依存元が auto-merge enabled（未マージ）→ main を pull してから作成（取り込まれていれば main ベース、未取り込みなら依存元 headRefName ベース）
  - `--merge` 未指定 → 依存元 PR の headRefName をベースに stacked PR として作成
- **並列起動:** 同一 wave 内の独立 subagent は **1 メッセージ複数 tool call** で並列起動する
- **並列度:** `min(4, wave 内タスク数)`、`--concurrency N` で上書き、8 超は警告のみ
- **wave 内タスク数 > 並列度:** semaphore 方式で空きスロット待ち（先に起動した subagent の完了を待ってから次を起動）

### 観測性

- Phase 0 完了時に wave 構成と target リストを表示する
- `Agent` tool は最終結果のみを返すためストリーム的な中間報告は不可。親は wave 起動時刻 `<T>` を ISO 8601 で記録し、30 秒間隔で `gh pr list --author @me --state open --search "created:>=<T>" --json number,url,headRefName,title` を polling する。既知 PR との差分から新規 PR を検出して URL を即時表示する
- Phase Final で集約レポートを出力する

### Phase Final-1: 親 worktree 整合性チェック

subagent が共有 git directory 経由で親の `HEAD` / `index` / `refs/heads/main` を汚染するケースに備えるための fail-safe（[Issue #66](https://github.com/ozzy-labs/skills/issues/66) / [Issue #77](https://github.com/ozzy-labs/skills/issues/77) / [Issue #89](https://github.com/ozzy-labs/skills/issues/89) 由来）。Phase 20 (opshub) 実行で「prompt 禁止だけでは subagent 4 並列のうち 3 件で汚染再発」、`/sync-consumers` epic 実行で「subagent 戻り値の自己申告と実態が乖離（worktree が `refs/heads/main` を握っていた）」が観察された。検出は 7 軸 + subagent 戻り値の `final_head_state` 交差確認で構成し、recovery は worktree lock を確実に回避するシーケンスで実行する。

検出は以下 7 軸 + 戻り値交差確認で行う:

1. `git rev-parse HEAD` と `git rev-parse $(git symbolic-ref HEAD)` が一致するか（HEAD が detached でないこと）
2. `git diff HEAD --stat` が空か（index が HEAD と乖離していないか）
3. `git status --short` が空か（working tree が clean か）
4. 親のベースブランチ（通常 `main`）が `git rev-parse origin/<base-branch>` と一致するか、または `--merge` で merged された PR の SHA を含むか
5. `git rev-parse refs/heads/main` と `git rev-parse origin/main` が一致するか（`refs/heads/main` ref が stuck していないか。`git reset --hard origin/main` だけでは ref が更新されず、HEAD が subagent branch を指す場合は subagent branch が reset されるだけで main ref は古い SHA のまま残る）
6. `git symbolic-ref HEAD` が `refs/heads/main`（ベースブランチ）を指しているか（subagent branch を指していないか）
7. **subagent worktree が `refs/heads/main` を握っていないか**（[Issue #89](https://github.com/ozzy-labs/skills/issues/89) 由来）。`git worktree list --porcelain` で各 subagent worktree (`.claude/worktrees/agent-<id>/`) を走査し、`branch refs/heads/main` を出すものがあれば warning。subagent は自 worktree branch (`feat/...` 等) で完結すべきで、`refs/heads/main` を握る = subagent が prompt 違反の操作 (例: `git symbolic-ref HEAD refs/heads/main`) を行った signal:

   ```bash
   git worktree list --porcelain | awk '/^worktree/{w=$2} /^branch refs\/heads\/main/{if(w!="<parent-root>") print "WARN: "w" holds refs/heads/main"}'
   ```

加えて、subagent 戻り値の `final_head_state.symbolic_ref` が `refs/heads/main` または空（detached）の場合は self-申告とも乖離している signal として warning に記録する（[Issue #89](https://github.com/ozzy-labs/skills/issues/89)）。

いずれかが不一致なら、集約レポート末尾に warning を出す。recovery シーケンスは worktree lock を確実に回避する順序で記載する:

```text
⚠️ Parent worktree drift detected:
  HEAD:                 <sha> (symbolic-ref: <ref>)
  refs/heads/main:      <sha> (expected: origin/main = <sha>)
  index diff:           <files>
  working tree:         <files>
  Recovery (push 前の汚染に対する確実な回復シーケンス):

    # 1. 現状把握 + subagent branch 名を保存
    #    step 3 で HEAD を main に切替えると `git symbolic-ref HEAD` は main を返すため、
    #    step 5 で参照する branch 名はここで変数に保存しておく必要がある
    SUBAGENT_BRANCH=$(git symbolic-ref --short HEAD)
    git rev-parse HEAD
    git rev-parse refs/heads/main
    git rev-parse origin/main
    git symbolic-ref HEAD
    git status --short
    git diff HEAD origin/main --stat  # 内容比較。空なら reset で安全に消せる

    # 2. main ref を origin/main に揃える (HEAD が subagent branch を指していても影響なし)
    git update-ref refs/heads/main origin/main

    # 3. HEAD を main に切替 (git checkout main は worktree lock で失敗するため update-ref 系を使う)
    git symbolic-ref HEAD refs/heads/main

    # 4. index + working tree を HEAD (= origin/main) と同期
    git reset --hard HEAD

    # 5. subagent stuck branch を削除 (HEAD だったため deletable に変わる。step 1 で保存した変数を使う)
    git branch -D "$SUBAGENT_BRANCH"
```

`git checkout main` 系は意図的に使わない（親 worktree が main を握っているため `fatal: 'main' is already used by worktree at ...` で失敗する）。`git update-ref refs/heads/main` を **先に**実行する点が load-bearing — 後にすると `reset --hard origin/main` が subagent branch を target にしてしまい、main ref が古い SHA で stuck したまま残る。

### Phase Final-2: subagent worktree cleanup

cleanup の status 別ポリシー（どの status を削除し、どれを残置するか）は canonical（`.agents/skills/drive/SKILL.md`）の Phase Final-2 に従う。本節は Claude Code worktree 機構固有の実行手順（[Issue #69](https://github.com/ozzy-labs/skills/issues/69) / [Issue #90](https://github.com/ozzy-labs/skills/issues/90) 由来）。

1. 今回起動した subagent のリストを保持する。各 subagent の worktree パス（`.claude/worktrees/agent-<id>/`）と戻り値 `status` をひとまず控える
2. **各 worktree の処理は subshell で囲む**（[Issue #90](https://github.com/ozzy-labs/skills/issues/90) 由来）。`git worktree remove` の副作用で親 shell の cwd が「No such file or directory」状態になり、以降の git コマンド全てが fail する現象が観察されたため、subshell で囲って cwd 喪失を伝播させない。Bash の中で以下のパターンで実行する:

   ```bash
   for WT_ID in <agent-id-1> <agent-id-2> ...; do
     (
       cd <parent-worktree-root>  # subshell 内で明示的に親 root に cd
       WT_PATH=".claude/worktrees/agent-$WT_ID"
       BRANCH=$(git worktree list --porcelain | awk -v p="$WT_PATH" '$1=="worktree" && $2 ~ p {getline; getline; if($1=="branch") print $2}' | sed 's|refs/heads/||')
       git worktree remove -f -f "$WT_PATH"
       [ -n "$BRANCH" ] && git branch -D "$BRANCH"
       git branch -D "worktree-agent-$WT_ID"
     )
   done
   ```

   subshell の終了で cwd 変化は親に伝播せず、次の iteration も clean state で始まる。`cd <parent-worktree-root>` は subshell ごとに明示する（保険）。

3. `merged` の subagent を cleanup する際の手順:
   - `git worktree list --porcelain` で当該 worktree が握っている branch を取得する（パターンマッチに頼らない）
   - `git worktree remove -f -f <path>` を実行する（`-f -f` の二重 force は Claude Code harness の `lock` 解除のため必須）
   - 取得した branch を `git branch -D <branch>` で削除する
4. `worktree-agent-<id>` 形式の synthetic branch（Claude Code harness 実装由来）が残っていれば `git branch -D worktree-agent-<id>` で削除する。Phase 20 (opshub) では 4/4 で残置されたため実態は必須項目。検出失敗時は warning に留めるが、**最後に `git branch --list 'worktree-agent-*'` を必ず実行して残存件数が 0 であることを確認する**（残存ありなら warning に件数と branch 名を出す）

`merged` 以外で残置された worktree がある場合、または cleanup 自体に失敗した worktree がある場合の warning 形式:

```text
⚠️ Stale worktrees / branches detected:
  preserved (not yet merged):
    .claude/worktrees/agent-<id>  [<branch>]  ← #<N> auto-merge enabled; マージ後に手動削除
    .claude/worktrees/agent-<id>  [<branch>]  ← #<N> merge-ready; iterate 用に残置
  preserved (failed):
    .claude/worktrees/agent-<id>  [<branch>]  ← #<N> failed; resume 可能
  cleanup failed:
    .claude/worktrees/agent-<id>  [<branch>]  reason: <error>
  Manual cleanup:
    git worktree remove -f -f <path>
    git branch -D <branch>
```

### 中断時

いずれかのフェーズで中断した場合、AskUserQuestion で次のアクションを確認する:

- **「エラーを修正して再開する」** → 中断したフェーズから再開
- **「中断する」** → 終了

オーケストレーションモードで一部 task のみ失敗の場合は、Phase Final レポート出力後に AskUserQuestion で再開対象を確認する。

### 完了後

#### 単一モード

1. **`--merge` 指定時:** Phase 4 の手順に従いマージを実行し、結果を報告して終了する
2. **`--merge` 未指定時:** AskUserQuestion を呼び出す（`answers` パラメータは設定しない）
   - **「PR をマージする」** → `gh pr merge --squash --delete-branch` でマージを実行し、結果を報告する
   - **「追加の変更を行う」** → 終了する

#### オーケストレーションモード

1. **`--merge` 指定時:** 各 subagent が自 PR のマージまで完了させているため、Phase Final 集約レポートを出力して終了する
2. **`--merge` 未指定時:** Phase Final レポート出力後、AskUserQuestion を呼び出す
   - **「全 PR を一括マージする」** → 各 PR に対し順次 `gh pr merge --squash --delete-branch` を依存順に実行する。すべての PR が merged になった後、Phase Final-2 cleanup を **`merge-ready` だった subagent worktree に対して再度実行する**（マージ完了で cleanup 条件 `merged` を満たすようになるため）。cleanup 結果を追加レポートとして出力する
   - **「個別に対応する」** → 終了する。`merge-ready` の worktree は残置されたまま。ユーザーがマージ後に `/health` 領域 #7 または手動で整理する
