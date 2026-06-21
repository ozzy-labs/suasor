---
name: drive
description: Issue または指示から実装・PR 作成・セルフレビュー・修正を自動で回し、merge-ready な PR を出す。単一/複数の Issue/PR と明示依存記法に対応。オプションでマージまで実行可能。
---

# drive - Issue から merge-ready な PR まで自律駆動

Issue または指示を受け取り、実装 → ship → セルフレビュー → 修正を自動で繰り返して merge-ready な PR を作成する。複数 Issue/PR の並列駆動、オプションでマージまで完結させることが可能。

## 入力解析

引数を解析する。

### target の展開

以下の表記をすべて展開して target リストにする:

- 単一: `#42` / `42`
- カンマ列: `#1,#2`
- 範囲: `#3-5` → `#3, #4, #5`
- 空白列: `#1 #2`
- 混合: `#1,#3-5`
- テキスト指示: 上記いずれにも該当しない場合、指示として扱う（target は単一）

### 明示依存記法

`->` を含む引数は順次依存を表す:

- `#1,#2 -> #3`: #1 と #2 は並列、#3 は両者の完了後
- `#1 -> #2 -> #3`: 完全直列

### オプション

- `--merge`: 自動マージを試行する
- `--concurrency N`: 並列度を上書きする（既定 `min(4, タスク数)`、N > 8 は警告のみ）
- `--review=<mode>`: review モード（既定 `quick`）。値は次のいずれか:
  - `quick`（既定）: 全 review pass で quick モード（最大 3 回）
  - `final-deep`: quick で最大 2 回 loop し、最終 pass のみ deep に格上げ（quick 2 + deep 1）
  - `deep`: 全 pass で deep モード（最大 1 回。コスト爆発防止）

  オーケストレーションモードでは `--review=quick` を強制し、`final-deep` / `deep` 指定時は警告を出して `quick` にフォールバックする。

- usage-guard: Claude Code の Usage Limit 超過手前で作業を pause し、枠回復後に自動再開する。**既定で有効（opt-out）**。無効化するには `--no-usage-guard` を付ける。**Claude Code 環境のみ**で実効する（`review --deep` と同じ扱い。OAuth 使用率エンドポイント + `ScheduleWakeup` 依存のため他アダプタでは no-op）。既定 ON だが実効は claude-code adapter のみで、他アダプタ（codex/gemini/copilot）では従来どおり何もしない。pause/resume の配線はホスト依存なので `SKILL.claude-code.md` の「usage-guard 配線（既定 ON・`--no-usage-guard` で無効化）」で吸収する。
  - `--no-usage-guard`: usage-guard を無効化し、checkpoint を一切挟まない素の drive を実行する。
  - `--usage-guard`: 後方互換のための **deprecated no-op エイリアス**（既定で有効になったため明示は不要）。受理するが挙動は既定 ON と同一。
  - 停止は **resumable unit の入口**でのみ行う（単一モード: Phase 1 開始前 / review loop 各反復前、オーケストレーション: 各 wave 開始前 / worker dispatch 前）。mid-implement（PR 作成前）では止めない。
  - orchestration の停止粒度は **wave 境界**。一度起動した走行中 worker の mid-unit 超過はこのフラグでは止められず、PreToolUse hook（#123）が ceiling を担う。
  - 超過時は枠リセットまで待機してから継続コマンド `/drive <元の引数>` を自己再入する（drive 冪等 resume で続行）。`--no-usage-guard` がユーザー指定されていた場合のみ継続コマンドにも引き継ぐ（`--usage-guard` を強制付与しない）。
  - usage-guard skill / `usage-check.mjs` が未インストールの環境でもエラーで drive を止めない。skill 不在を検出したら 1 行警告を出し、そのまま通常進行する（fail-open 扱い）。

### モード分岐

- target が 1 件かつ依存記法なし → **単一モード**
- target が 2 件以上、または依存記法あり → **オーケストレーションモード**

## 単一モード

### Phase 1: implement

implement スキルのワークフローを実行する。ただし以下の点が異なる:

- **計画承認をスキップ:** drive を実行した時点でユーザーは自律実行を委任しているため、計画を自ら承認して実装を進める
- **完了報告・次のアクション確認は無視:** フェーズ間の遷移は本スキルが制御する

**中断条件:** 動作確認が繰り返し失敗する場合 → エラーを報告して中断

### Phase 2: ship

ship スキルのワークフロー（lint → commit → PR 作成）を実行する。完了報告・次のアクション確認は無視する。

- PR 番号を記録する（Phase 3 で使用）
- **冪等性:** 既存 PR を検出した場合は resume として扱い、新規作成せず Phase 3 から再開する。判定基準:
  - target が PR 番号 → その PR を採用
  - target が issue 番号 → `gh pr list --search "in:body #<N>" --state open` で取得した最新 1 件、または現在のブランチ名と一致する PR を採用

**中断条件:** lint が失敗し、自動修正できない場合 → エラーを報告して中断

### Phase 3: review loop（観点別終了基準で判定）

review skill の観点別 `exit_criteria.drive_loop` を集約して終了判定する。loop 上限は `--review` モードで切替える:

| `--review` | quick の最大回数 | deep の最大回数 | 備考 |
| --- | --- | --- | --- |
| `quick`（既定） | 3 | 0 | 全 review pass で quick |
| `final-deep` | 2 | 1（最終 pass のみ） | quick で loop し、最終 pass のみ deep |
| `deep` | 0 | 1 | 全 pass で deep。コスト爆発防止のため最大 1 回 |

各 pass の手順:

1. **レビュー実行:** review スキルで PR をレビューし、結果を PR コメントとして投稿する。このとき PR コメント末尾の HTML コメント `<!-- review-json:v<N> ... -->` に JSON を埋め込む（[ADR-0025](https://github.com/ozzy-labs/handbook/blob/main/adr/0025-skills-review-multi-perspective.md) Schema v1）
2. **判定:**
   - JSON を解析できる場合 → 観点別 `exit_criteria.drive_loop` を **すべて** 満たすか判定する。`exit_criteria` は対応する `perspectives/<axis>.md` の `exit_criteria.drive_loop` を参照する（観点ごとに critical / warning の許容しきい値が異なる）
   - すべての適用観点が `exit_criteria` を満たす → ループを終了（merge-ready）
   - 1 つでも未達観点がある → 修正に進む
   - JSON 解析失敗 / `unknown_review_version` → fail-soft で人間可読部分のみ扱い、Critical または Warning が 0 件かどうかで判定（旧挙動互換）
   - ループ上限に到達 → ループを終了（残存指摘を報告に含める）
3. **修正:** 未達観点の Critical および Warning の指摘事項のみを修正する。Info は修正しない（報告のみ）。修正後、lint → commit → push を実行し、1 に戻る

`--review=final-deep` の場合、最後の pass（quick 上限到達直前または最終 1 回ぶん）のみ deep モードで再 review する。

`unknown_review_version` を検出した場合は、JSON を無視して人間可読部分のみで判定し、loop はそのまま継続する（schema bump 後の互換維持）。

#### 既存 PR コメントとの resume 互換

- 過去の PR コメントに `<!-- review-json:v<N> -->` が含まれない場合、その PR は **legacy comment** とみなし、新しい review pass を実行する（旧コメントは消さない）
- `<!-- review-json:v<unknown> -->` の場合も同様に新規 pass を実行する

### Phase 4: merge (optional)

`--merge` 指定時に実行する。

1. **Auto-merge の有効化:** `gh pr merge --auto --squash --delete-branch` を実行する
   - **オーケストレーションの worker として単一モードを実行する場合は `--delete-branch` を省略する:** 隔離された作業コピーが当該 branch を保持しているため削除に失敗する。ローカル branch / 作業コピーの整理は親側 Phase Final で一括処理する（ホスト固有の詳細は各 `SKILL.<adapter>.md` を参照）
2. **成否の確認:**
   - 成功（Auto-merge がセットされた、または即時マージされた）→ 次へ
   - 失敗（Auto-merge がリポジトリで無効など）→ ユーザーに通知し、手動マージを促す（状態を `merge-ready` にする）
3. **マージ完了の polling（オーケストレーションから呼ばれた場合のみ）:**
   - `gh pr view --json mergedAt,state` で mergedAt が立つ、または state が `MERGED` になるまで待つ
   - polling 間隔 30 秒、最大 30 分。タイムアウト時は状態を `auto-merge enabled` として終了
4. **クリーンアップ（即時マージされた場合）:**
   - ローカルブランチが削除され、ベースブランチ（main 等）に切り替わっていることを確認する
   - ベースブランチで `git pull` を実行し、最新の状態に同期する

### Phase 5: 完了報告

```text
drive 完了:
  Issue:    #<number> <title>
  ブランチ: <branch-name>
  PR:       <PR URL>
  レビュー: N 回実施 (mode: <quick|final-deep|deep>)
            総計 Critical: 0, Warning: 0, Info: N
            by_axis: correctness:C0W0I0 security:C0W0I0 ...
  状態:     <merged | merge-ready | auto-merge enabled | failed>
```

## オーケストレーションモード

### Phase 0: 入力展開と DAG 構築

1. 引数を target リストに展開する
2. 各 target について GitHub から情報を取得する:
   - issue: `gh issue view <N> --json number,title,body`
   - PR: `gh pr view <N> --json number,title,body,baseRefName,headRefName`
   - issue/PR の判別が曖昧な場合は両方を試し、ヒットした方を採用する
3. DAG を構築する:
   - **明示依存記法（最優先・確実）:** 引数の `->` から登録
   - **PR base ブランチ照合（確実）:** ある PR の baseRefName が同セット内の別 PR の headRefName に一致する場合、stacked PR として依存登録
   - **issue 本文の自動検出（best-effort）:** "depends on #X" / "blocked by #X" / "after #X" 等を grep で抽出。表記ゆれや日本語表現で取りこぼしてもエラーにせず並列扱いにフォールバック
4. DAG を wave に分割する（topological levels）。循環依存を検出した場合はエラー報告して中断する
5. wave 構成と target リストを表示する:

```text
drive 開始:
  Targets:  #1, #2, #3, #4, #5
  並列度:    4 (既定: min(4, タスク数))
  --merge:  有効
  Waves:
    Wave 1: #1, #2 (並列)
    Wave 2: #3 (← #1, #2)
    Wave 3: #4, #5 (並列, ← #3)
```

### Phase 1..N: wave 並列実行

wave を順に実行する。

#### 並列度

- 既定: `min(4, wave 内タスク数)`
- `--concurrency N` で上書き
- N > 8 の場合は警告を表示して続行（ハードキャップなし）

#### worker dispatch

各 target に対し worker（並列実行単位）を起動する。同時起動数は並列度まで、空きが出たら次を投入する。worker の起動機構と、親リポジトリの git 状態を保護するための禁止事項・tool 制約は**並列実行機構に依存する**ため、ホスト固有の手順に従う（Claude Code: `SKILL.claude-code.md` の「subagent dispatch」）。

- **隔離:** worker は必ず隔離された作業コピーで起動する（必須。並列実行時の作業ディレクトリ衝突防止）。worker は自分の作業コピーと branch の中で完結し、親側のベースブランチ・ref・作業コピーには一切書き込まない
- **委譲粒度:** worker には本 SKILL.md を読み込ませ、target #N について単一モードのワークフロー（Phase 1-5）を実行させる
- **`--delete-branch` 禁止:** worker が `gh pr merge` を呼ぶ際、`--delete-branch` フラグは使わない。隔離された作業コピーが当該 branch を保持しているため削除に失敗する。ローカル branch / 作業コピーの整理は親の Phase Final で一括処理する
- **scope 外波及の最低限チェック:** 自 issue で schema enum / field / CLI flag を追加した場合、リポ全体で対応する help 文字列・エラーメッセージ・サンプル/docs を grep し、同期されているか確認する（例: `rg -n '<old-enum-list>' src/ docs/`）。同期されていなければ **可能なら自 PR に含める**（自 scope の自然な拡張として）。判断に迷う / 自 scope を明確に超える場合は修正せず、戻り値 `cross_cutting_gaps` に `<file>:<line> — <symbol> not synced` 形式で記録し、親の Phase Final-3 audit に集約する（[Issue #70](https://github.com/ozzy-labs/skills/issues/70)）
- **ベースブランチ:**
  - 依存元 wave がない target → main からブランチを作る
  - 依存元 wave がある target → 依存元 PR の `headRefName` をベースにブランチを作る（stacked PR）。`--merge` 指定時は依存元がマージ済みのため main をベースにできるが、未指定時はこの stacked 構造が必須
- **戻り値:** 各 worker は完了時に以下の JSON を返す

```json
{
  "target": "#<N>",
  "title": "<issue/PR title>",
  "branch": "<branch-name>",
  "pr_url": "<URL>",
  "pr_number": <N>,
  "status": "merged" | "merge-ready" | "auto-merge enabled" | "failed",
  "review": {
    "mode": "quick" | "final-deep" | "deep",
    "axes_applied": ["security", "..."],
    "by_axis": {"security": {"critical": 0, "warning": 0, "info": 0}, ...},
    "total": {"critical": 0, "warning": 0, "info": 0},
    "iterations": <N>
  },
  "cross_cutting_gaps": [
    "src/cli/foo.ts:213 — help text missing new kind 'html-js'",
    "src/cli/foo.ts:299 — validation error message lists old enum set"
  ],
  "final_head_state": {
    "symbolic_ref": "<git symbolic-ref HEAD 出力、例: refs/heads/feat/foo>",
    "rev_parse_HEAD": "<git rev-parse HEAD 出力>",
    "status_short": "<git status --short 出力、clean なら空文字列>"
  },
  "error": "<message if failed>"
}
```

`cross_cutting_gaps` は worker が「scope 外波及の最低限チェック」で気付いたが自 PR では修正しなかった項目を記録する任意フィールド（空配列でも可）。フィールドが欠落している戻り値も後方互換のためエラーにせず、`[]` として扱う。親は Phase Final-3 post-merge audit でこれを集約し、独自検出した gap と統合して warning として list-up する。

`final_head_state` は worker 完了時点の自作業コピーの git HEAD 状態を必ず申告するフィールド。自己申告と実態が乖離した観察例があるため、戻り値で実測値を提出させて親側 Phase Final-1 で交差確認する。フィールドが欠落している場合は後方互換のため `null` 扱いとし、交差確認を skip する（乖離の判定基準はホスト固有の手順を参照）。

#### 観測性

- worker の実行中はストリーム的な中間報告ができない場合があるため、親は wave 起動時刻 `<T>` を ISO 8601 で記録し、30 秒間隔で `gh pr list --author @me --state open --search "created:>=<T>" --json number,url,headRefName,title` を polling する
- 既知 PR との差分から新規作成 PR を検出し、URL を即時表示する
- 全 worker 完了時に最終 JSON 戻り値で状態を確定する

#### wave 完了待ち

- すべての worker が完了した時点で wave 完了
- `--merge` 指定時、各 worker は自 PR のマージ完了まで polling して終了するため、wave 完了 = wave 内全 PR のマージ完了
- `--merge` 未指定時、wave 完了 = wave 内全 PR が merge-ready 以上になった時点。後続 wave は前段 PR の `headRefName` をベースに stacked PR として作成する

#### 失敗・merge-ready task の処理

| 上流の状態 | downstream の扱い |
|---|---|
| merged（`--merge` 指定 + auto-merge 成功） | 進める（`git pull origin main` 後に main ベース） |
| auto-merge enabled（`--merge` + polling タイムアウト等で未マージ） | 進める（前段 PR の headRefName ベースで stacked PR） |
| merge-ready（`--merge` 未指定 / `--merge` 指定 + 残存指摘） | 進める（前段 PR の headRefName ベースで stacked PR） |
| failed | `skipped (upstream failed: #N)` として除外 |

- 失敗した target は記録する
- 独立した（依存関係のない）他 task には影響させない

### Phase Final: 集約レポート

Phase Final は次の 3 ステップで構成する。順に実行する。

#### Phase Final-1: 親作業コピーの整合性チェック

worker が親リポジトリの git 状態（`HEAD` / `index` / ベースブランチ ref）を汚染していないかを検証する fail-safe。具体的な検証軸・recovery シーケンスは並列実行機構に依存するため、ホスト固有の手順に従う（Claude Code: `SKILL.claude-code.md` の「Phase Final-1: 親 worktree 整合性チェック」）。

最低限、次の不変条件をホストによらず確認する:

1. 親の HEAD がベースブランチ（通常 `main`）を指し、detached でないこと
2. 親の index / working tree が clean であること
3. ベースブランチ ref が `origin/<base-branch>` と一致する（または `--merge` で merged された PR の SHA を含む）こと
4. worker 戻り値の `final_head_state` と実測の git 状態に乖離がないこと

いずれかが不一致なら、集約レポート末尾に warning と recovery 手順（ホスト固有）を出す。

#### Phase Final-2: worker 作業コピーの cleanup

**今回の drive 実行で起動した worker** の作業コピーと関連 local branch をクリーンアップする。今回の実行外の orphan（前回の異常終了で残ったもの等）は対象外。orphan の検出・整理は `/health` 領域 #7 に委譲する（[Issue #71](https://github.com/ozzy-labs/skills/issues/71)）。

status 別の cleanup ポリシー（ホスト共通）:

- **`merged`**: cleanup 対象（リモート merge 完了済み、ローカル iterate 不要）
- **`auto-merge enabled`**: cleanup **しない**（後で実マージされるまで状態保留、マージ後にユーザーが手動 / `/health` で整理）
- **`merge-ready`**: cleanup **しない**（ユーザーが手動マージ前にローカル iterate する余地を残す）
- **`failed`**: cleanup **しない**（再実行で resume できるよう残置）

具体的な削除手順と既知の落とし穴（cwd 喪失、lock 解除、synthetic branch の残置）は隔離機構に依存するため、ホスト固有の手順に従う（Claude Code: `SKILL.claude-code.md` の「Phase Final-2: subagent worktree cleanup」）。

cleanup 結果は集計して Phase Final-4 の集約レポートに含める。`merged` 以外で残置された作業コピーがある場合、または cleanup 自体に失敗した場合は、集約レポート末尾に残置一覧と手動 cleanup 手順（ホスト固有）を warning として出す。

#### Phase Final-3: post-merge audit (cross-cutting)

複数 worker が自 sub-issue scope に閉じて並列実行する結果、**scope を跨ぐ波及 (cross-cutting) が構造的に漏れる**ことがある（enum/field/CLI flag の help・エラーメッセージ・サンプルへの未反映、ステータス系文言の取り残し、lockfile drift 等）。集約レポート出力前に best-effort で検出する（[Issue #70](https://github.com/ozzy-labs/skills/issues/70) 由来）。

検出された gap は **すべて warning 扱い**で集約レポート末尾に list-up し、ユーザーに follow-up PR の要否を問う。critical / info への severity 分類はしない（best-effort 性質に合わせシンプルに保つ）。

**前提**: Phase Final-2 cleanup 後の main ブランチで実施する（merged PR の変更が main に取り込まれている状態）。`merged` 以外（`auto-merge enabled` / `merge-ready` / `failed`）の worker は対象外（main に未反映のため）。

各検査項目内の `gh pr diff` 呼び出しは独立しているため、複数 PR の diff 取得は並列実行してよい。

##### 0. worker からの報告を集約

検査の起点として、各 worker 戻り値の `cross_cutting_gaps` フィールドをすべて集約する。worker が自前で気付き、自 PR では修正しなかった gap がここに含まれる（[Issue #70](https://github.com/ozzy-labs/skills/issues/70) B2/B3）。

```text
worker #N の cross_cutting_gaps:
  - src/cli/foo.ts:213 — help text missing new kind 'html-js'
  - ...
```

集約した gap は後続の独自検出と重複排除して最終的な warning list を構成する。重複判定キーは `file:line` を基本とし、同一 `file:line` で複数の異なる message がある場合は両方併記する（情報を捨てない）。

##### 1. cross-cutting symbol の同期確認 (heuristic)

各 worker の戻り値 `pr_number` に対し `gh pr diff <N>` で差分を取得し、新規追加された enum 値・field 名・CLI flag らしき symbol を heuristic に抽出する。例:

```bash
# 追加された enum 値 / case 文 / object literal の値 を抽出
gh pr diff <N> | grep -E '^\+' | grep -oE '(case\s+["'\'']\w[\w-]+["'\''])|(--[a-z][a-z0-9-]+)|(["'\''][a-z][a-z0-9-]+["'\''])' | sort -u
```

抽出した symbol を repo 全体で grep し、help 文字列・エラーメッセージ・サンプル・docs に同期されているか確認する:

```bash
rg -n --no-heading '<symbol>' src/ docs/
```

抽出に偽陽性は許容する（grep は AI 判断のサポートツール）。AI は抽出結果を見て「この symbol は CLI 層の help にも追加されるべきか」を判断し、未同期と思われるものを gap として list-up する。

##### 2. 古い文言の残骸検出

ステータス系 keyword (`alpha`, `beta`, `Phase \d+`, `pending`, `TODO`, `FIXME` 等) が merged PR 群で削除されている場合、同じ文字列が他ファイルに残骸として残っていないか確認する:

```bash
# 各 merged PR で削除された status keyword 行を抽出
for PR in <pr_numbers>; do
  gh pr diff $PR | grep -E '^-' | grep -iE '(alpha|beta|phase\s+[0-9]+|pending)'
done

# 残骸を repo 全体で grep
rg -n --no-heading -iE '(alpha|beta|phase\s+[0-9]+|pending)' src/ docs/ README.md
```

固有名詞として正当な使用 (例: `alpha` がリリースチャネル名として残るべき) は AI が判断して除外する。

##### 3. lockfile drift

`pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` / `uv.lock` 等が merged PR で変更されているが対応する manifest (`package.json` / `pyproject.toml` 等) が変更されていない、またはその逆を検出する:

```bash
# 今 drive 実行で merged になった PR の数だけ遡って変更ファイルを取得
# (1 PR = squash merge で 1 commit のため、merged_pr_count == commit 数)
git diff --name-only origin/main~<merged_pr_count>..origin/main
```

manifest と lockfile の対応関係を確認し、不整合があれば gap として list-up する。

##### 4. docs ⇄ code grep 整合 (スコープ縮小版)

docs 系の merged PR (タイトルが `docs:` / `docs(<scope>):` 等) の diff から追加された CLI 呼び出し文字列を抽出し、code 側に対応する文字列が存在するか grep で確認する。

```bash
# docs PR の追加された code block 内 CLI 文字列を抽出
gh pr diff <docs_pr_number> | grep -E '^\+' | grep -oE '`[a-z][a-z0-9-]+\s+[a-z][^`]*`|--[a-z][a-z0-9-]+'

# code 側で対応する文字列を grep
rg -n --no-heading '<extracted_cli_string>' src/
```

「実行ベース」検証（実際に `<cmd> --help` を実行して確認）は行わない（リポによって CLI 構成が違うため汎用化困難）。grep ベースの整合確認のみ。

##### 検出結果の出力

gap が検出されたら、Phase Final-4 集約レポート末尾に warning として追記する。gap が 0 件なら warning ブロックは出力せず、集計行 `cross-cutting:` のみ `none` 表示にする:

```text
⚠️ Cross-cutting gaps detected:
  enum/field/flag sync:
    src/cli/foo.ts:213 — help text missing new kind 'html-js' (PR #N で追加)
    src/cli/foo.ts:299 — validation error message lists old enum set (PR #N で追加)
  stale status text:
    src/cli/index.ts:52 — outdated "Status: alpha" (PR #M で他から削除済み)
  lockfile drift:
    pnpm-lock.yaml changed but package.json not changed in this drive run
  docs/code mismatch:
    docs/user-guide.md:42 references `--flag-x` but not found in src/cli/
  Recommended: follow-up PR(s) to fix
```

gap が 0 件の場合は warning ブロックを省略し、Phase Final-4 集計行のみ `cross-cutting: none` と表示する（ノイズ抑制）。

#### Phase Final-4: 集約レポート

整合性チェック・cleanup・post-merge audit の結果を踏まえ、集約レポートを出力する:

```text
drive 完了 (3/5 merged, 1 merge-ready, 1 skipped):
  #1 feat: ...        | PR #100 | merged
  #2 fix:  ...        | PR #101 | merged       (Review: C0 W0 I2)
  #3 feat: ...        | PR #102 | merge-ready  (Review: C0 W1 I0)
  #4 chore: ...       | skipped (upstream failed: #5)
  #5 refactor: ...    | failed (test loop)

集計:
  merged:           2
  merge-ready:      1
  skipped:          1
  failed:           1
  総レビュー反復:    5 回
  cleanup:          2/5 removed (3 preserved: 1 merge-ready, 1 failed, 1 skipped)
  cross-cutting:    2 gaps detected (warning)
```

`cross-cutting:` 行は Phase Final-3 で gap が検出された場合は `<N> gaps detected (warning)` を表示し、詳細は前述の warning ブロックを参照する。gap が 0 件なら `cross-cutting: none` と表示し warning ブロックは出力しない。

## 失敗 semantics

| 状況 | 扱い | downstream への影響 |
|---|---|---|
| review loop 上限後も観点別 exit_criteria 未達 | partial success（merge-ready） | 影響なし |
| auto-merge セット失敗（branch protection 等） | failed | skipped |
| implement / ship 中断（テスト失敗等） | failed | skipped |
| 独立 task の失敗 | 他並列 task に影響させない | - |

## 注意事項

- .env ファイルは読み取り・ステージングしない
- `gh` CLI が未認証の場合はエラーメッセージを表示して中断する
- マージはデフォルトでは行わない。`--merge` 指定時のみ Auto-merge を試行する
- Info 指摘は修正せず報告のみ（設計判断に関わる変更を機械的に行わない）
- オーケストレーションモードでは worker を必ず隔離された作業コピーで起動する（隔離機構はホスト依存）
- 並列度 8 超過は警告のみ。GitHub Actions 同時実行枠 / API rate limit / 観測性 / コストに注意
- 循環依存を検出した場合はエラー報告して中断する
