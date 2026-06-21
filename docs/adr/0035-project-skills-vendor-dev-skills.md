# 0035. Project skills — vendor ecosystem dev skills; stop dogfood-committing assistant mirrors

- Status: Accepted
- Date: 2026-06-22
- Deciders: Suasor maintainers

## Context

[ADR-0008](0008-assistant-skills.md) は 2 つの判断を含んでいた:

1. アシスタント skill の SSOT は `docs/skills/<name>/SKILL.md`。配信はパッケージ同梱 + `suasor skills install`。
   **in-repo では展開結果（`.claude/skills/` / `.agents/skills/`）を dogfood として commit** し、
   pre-commit hook `scripts/skills-drift.sh` が SSOT ↔ mirror の byte-identity を強制する。
2. エコシステム共通 dev skill（drive / lint / commit 等）は `@ozzylabs/skills` 経由で**別供給（名前空間 disjoint）**。

運用の結果、次の摩擦が判明した:

- dev skill と assistant mirror は**同じ host dir（`.claude/skills/` / `.agents/skills/`）に同居**する。
  `skills-drift.sh` は host dir 配下に `docs/skills/` 対応の無いディレクトリを見つけると「orphan mirror」として
  commit を止めるため、**dev skill をその host dir に置くと一切 commit できない**（`--no-verify` はリポ規約で禁止）。
- 一方、dev skill を repo に commit したい正当な動機がある: **cloud / mobile の Claude Code は repo を checkout して
  `.claude/skills/` を読む**ため、ローカル install できない環境で dev skill を使うには commit が必要。
- assistant mirror の commit が買っている価値は乏しい。npm 出荷物は `docs/skills/` のみ（`package.json` `files`）、
  install の正しさは `tests/skills/install.test.ts` が担保する。mirror 58 ファイルは重複で、上記同居衝突の主因。

## Decision

`.claude/skills/` / `.agents/skills/` を **「suasor 自体の開発に使う project skill（dev tooling）の置き場」** と再定義する。

1. **assistant skill の mirror は in-repo に commit しない。** SSOT は `docs/skills/` のまま（出荷・`suasor skills install`
   は不変）。host dir に展開された mirror は**ローカル install 物として `.gitignore`** する。dogfood の検証は
   `tests/skills/install.test.ts` に委ねる。
2. **エコシステム共通 dev skill（drive / lint / commit / review / ship / test / pr / implement / lessons-triage /
   lint-rules / commit-conventions / usage-guard）を project skill として `.claude/skills/` と `.agents/skills/` の
   両方に vendor commit** する（`usage-guard` は Claude 専用のため `.claude/skills/` のみ）。`.claude/agents/` の
   レビュー用 agent 定義も同様に commit する。
3. **`scripts/skills-drift.sh` と lefthook の `skills-drift` フックを廃止。** mirror を commit しなくなり検査対象が
   消えるため。`.gitignore` は host dir を全 ignore し、vendored dev skill だけを negate（allowlist）して、
   将来 install される assistant mirror を自動で ignore する。
4. **vendored dev skill と `@ozzylabs/skills` の同期は手動 re-vendor。** 更新時は外部 installer を再実行して
   host dir を更新し、結果を commit する。手順は [docs/skills/dev-skills-refresh.md](../skills/dev-skills-refresh.md)
   に記す。

ADR-0008 の「アシスタント skill を提供し SSOT を `docs/skills/` に置く」という中核判断は維持する。本 ADR は
ADR-0008 の **(1) の dogfood-commit 部分**と **(2) の dev skill 配置**のみを改訂する。

## Consequences

### Positive

- dev skill が repo に乗るため **cloud / mobile の Claude Code でも `.claude/skills/` 経由で使える**。
- assistant mirror 58 ファイルの重複と `skills-drift` フックの保守が消える。host dir の同居衝突が解消。
- project skill = 開発ツール、という直感に沿った構成になる（`lefthook.yaml` 等の dev tooling と同列）。

### Negative / Trade-offs

- vendored dev skill は `@ozzylabs/skills` との **SSOT 二重化**になる。上流更新が自動反映されず、手動 re-vendor の
  運用が要る（drift しうる）。
- assistant skill のローカル展開結果は untracked になるため、各開発者は必要なら `suasor skills install` を自分で実行する。

## Alternatives Considered

- **host dir を一切 commit しない（assistant mirror 削除 + dev skill も commit しない）** → 却下。最もクリーンだが
  cloud / mobile で skill がゼロになり、dev skill を使いたいという動機を満たせない。
- **assistant mirror commit を維持し、dev skill 用に別 namespace dir を新設** → 却下。dogfood-commit の重複と
  drift フック保守が残り、host dir 構成が複雑化する。
- **dev skill を npm 依存として `node_modules` から読む** → 却下。Claude Code は host dir 配下の SKILL.md を読むため、
  `node_modules` 配置では skill として認識されない。
