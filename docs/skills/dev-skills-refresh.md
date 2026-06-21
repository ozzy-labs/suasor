# Dev skills の更新（re-vendor）手順

[ADR-0035](../adr/0035-project-skills-vendor-dev-skills.md) に基づき、エコシステム共通 dev skill
（drive / lint / commit / ship / pr / review / implement / test / lessons-triage / lint-rules /
commit-conventions / usage-guard）は `@ozzylabs/skills` 由来の **vendored project skill** として
本リポジトリに commit している。

これらは `@ozzylabs/skills` 側が SSOT のため、リポジトリ内のコピーは**手動 re-vendor で同期する**
（自動同期はしない — SSOT 二重化の trade-off。ADR-0035 §Consequences）。

## 何が commit されているか

| 場所 | 内容 |
|---|---|
| `.claude/skills/<dev-skill>/` | Claude Code 用 dev skill（`usage-guard` を含む） |
| `.agents/skills/<dev-skill>/` | Codex / Gemini / Copilot 用 dev skill（`usage-guard` は Claude 専用のため無し） |
| `.claude/agents/` | レビュー用 agent 定義（例: `code-reviewer.md`） |

assistant skill（`docs/skills/` SSOT）の mirror は **commit しない**。host dir 配下は `.gitignore` で
全 ignore し、上記 vendored dev skill のみ allowlist で再追跡している。

## 更新手順

1. `@ozzylabs/skills` の installer（エコシステムの `sync-skills.sh`。本リポの `AGENTS.md` の
   `<!-- begin/end: @ozzylabs/skills -->` managed block を管理するスクリプト）を実行し、host dir
   （`.claude/skills/` / `.agents/skills/`）の dev skill を最新へ更新する。

   > installer の正確な起動方法は `@ozzylabs/skills` の配布元に従う。リポにバイナリ依存として
   > 同梱していないため、グローバル / dotfiles 側のセットアップで実行する。

2. 差分を確認する。assistant mirror は `.gitignore` 済みなので、`git status` には vendored dev skill
   の変更だけが現れるはず:

   ```bash
   git status --short .claude/skills .agents/skills .claude/agents
   ```

3. dev skill の変更を stage して commit する（assistant mirror が混ざっていないことを確認）:

   ```bash
   git add .claude/skills .agents/skills .claude/agents
   git diff --cached --name-only   # vendored dev skill のみであることを確認
   git commit -m "chore(skills): re-vendor dev skills from @ozzylabs/skills"
   ```

## 新しい dev skill を追加 / 削除したとき

vendored dev skill の集合を変えた場合は `.gitignore` の allowlist（`!.claude/skills/<name>/` /
`!.agents/skills/<name>/`）も合わせて更新する。allowlist に無い skill は ignore され commit されない。

## 確認（任意）

```bash
# assistant mirror は ignore される
git check-ignore .claude/skills/personal-brief/SKILL.md
# vendored dev skill は ignore されない（出力なし = 追跡対象）
git check-ignore .claude/skills/drive/SKILL.md || echo "tracked"
```
