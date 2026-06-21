---
name: lessons-triage
description: セッション教訓 queue（~/.agents/lessons/queue.jsonl）を消化し、transcript から User Skills に関する教訓を抽出して、承認された分のみ ozzy-labs/skills へ issue 起票する。「教訓を整理して」「lessons を消化して」「セッションの振り返り」で発火。
---

# lessons-triage - セッション教訓の HITL トリアージ

セッション終了時に capture hook（dotfiles の `lesson-capture.sh`）が `~/.agents/lessons/queue.jsonl` へ蓄積したセッションメタ情報を消化し、transcript から **User Skills の改善に関する教訓のみ** を抽出して、ユーザー承認済みの教訓を ozzy-labs/skills の issue として起票する。

## 前提と原則

- **v1 のスコープは User Skills の改善のみ。** 一般的な教訓（ユーザー好み・コーディング規約等）は対象外
- **auto-apply 経路なし。** issue 起票は 1 件ずつユーザー承認を得てから行う
- **transcript の内容を外部 CLI / 外部サービスへ渡さない。** gemini-delegate 等への委譲は禁止（transcript は private リポの内容や端末出力中の秘密情報を含みうる）
- **issue 起票以外の外部反映を行わない。** リポ編集・PR 作成・メモリ書き込みは本 skill のスコープ外
- queue / processed への書き込みは**追記のみ**。queue 自体は書き換えない（capture hook との競合回避）

## 入力

| ファイル | 役割 |
| --- | --- |
| `~/.agents/lessons/queue.jsonl` | capture hook の出力。1 行 = 1 セッション終了イベント（`queued_at` / `cli` / `session_id` / `cwd` / `transcript_path` / `reason`） |
| `~/.agents/lessons/processed.jsonl` | 本 skill の処理済み記録。1 行 = 1 セッション（`processed_at` / `session_id` / `cli` / `outcome`） |

引数: `--limit N` で 1 回に処理する最大セッション数を指定（デフォルト 10、古い順 = FIFO。transcript の失効前に消化するため）。

## 手順

### 1. 未処理セッションの特定

1. `~/.agents/lessons/queue.jsonl` が存在しない・空の場合は「queue は空」と報告して終了する
2. queue の `session_id` 集合から `processed.jsonl` に記録済みの `session_id` を除外する
3. 同一 `session_id` の重複行（resume 往復等で発生）は最新の 1 行に集約する
4. 古い順に最大 `--limit` 件を処理対象とする

### 2. プレフィルタ（破棄候補の一括処理)

以下に該当するセッションは教訓抽出をスキップし、破棄候補としてまとめてユーザーに提示する。確認後 `processed.jsonl` へ記録する:

- `transcript_path` のファイルが存在しない（失効）→ `outcome: transcript-missing`
- transcript に skill 呼び出しの痕跡がない（インストール済み skill の実行記録が見当たらない）→ `outcome: no-skill-usage`
- lessons-triage 自身を実行したセッション → `outcome: self`

### 3. 教訓抽出

残った各セッションの transcript を読み、以下に該当する出来事を抽出する:

1. **skill の誤発火 / 不発火**: 意図しない skill が起動した、または発火すべき場面で起動しなかった
2. **手順の曖昧さ・誤り**: skill の手順どおりに進めた結果、ユーザーの修正・差し戻しが発生した
3. **実行中の摩擦**: skill 実行中の繰り返しエラー、再試行、手順の迂回
4. **新 skill / 機能候補**: 既存 skill でカバーされていない反復的な手作業

transcript が大きい場合は skill 実行区間を優先して読む（全文の逐語読解は不要）。各教訓は以下に整理する:

- **対象 skill**: skill 名（新規候補の場合は「新規」）
- **事象**: 何が起きたか
- **根拠**: transcript 内の該当箇所の要約（逐語引用は最小限）
- **改善案**: SKILL.md / アダプタ wrapper のどこをどう変えるか

### 4. HITL 承認と issue 起票

抽出した教訓を 1 件ずつユーザーに提示し、確認を取る（起票する / 修正して起票する / 破棄する）。

承認された教訓のみ、以下の形式で issue を起票する:

```bash
gh issue create --repo ozzy-labs/skills --title "[lessons] <skill>: <要約>" --body "<本文>"
```

本文テンプレート:

```markdown
## 教訓

<事象の説明>

## 根拠

- セッション: <cli> / <queued_at> / <cwd>
- <該当箇所の要約>

## 改善案

<変更箇所と変更内容の提案>

---
Filed by lessons-triage (session: <session_id>)
```

**issue 本文に transcript の逐語引用・機密情報（トークン、内部パス、private リポの内容等）を含めない。** 要約のみを記載する。

### 5. 処理済み記録

教訓抽出まで終えたセッションの `session_id` を `processed.jsonl` へ追記する:

```json
{"processed_at": "<ISO 8601>", "session_id": "<id>", "cli": "<cli>", "outcome": "issues-created:<N>" }
```

`outcome` は `issues-created:<N>` / `no-findings` / `discarded` / `transcript-missing` / `no-skill-usage` / `self` のいずれか。

### 6. 完了報告

```text
lessons-triage 完了:
  処理セッション: N 件（プレフィルタ破棄: M 件）
  抽出教訓:      K 件
  起票 issue:    J 件
    - <issue URL> [lessons] <skill>: <要約>
  残 queue:      L 件（次回 --limit で消化）
```

## 注意事項

- `.env` ファイルは読み取らない
- `gh` CLI が未認証の場合はエラーメッセージを表示して中断する
- 将来拡張（メモリ / AGENTS.md / CLAUDE.md への反映ルート）は本 skill のスコープ外。手順 4 の分類ロジックに反映先ルートを後付けできる設計とする
