# 0004. MCP as the agent boundary, with HITL writes

- Status: Accepted
- Date: 2026-06-14
- Deciders: Suasor maintainers

## Context

Suasor の主たる利用者は人間ではなく **AI エージェント（Claude Code / Codex / Claude Desktop 等）**。エージェントが Suasor の記憶・機能をどう叩くか、そして「勝手に行動しない」をどう担保するかを定める必要がある。

## Decision

**MCP (Model Context Protocol) をエージェント境界**にする。Suasor の機能は MCP tool として公開し、tool を **read / write の 2 カテゴリ**に分ける:

- **read tool**（検索・要約・一覧・recall 等）= 副作用なし、エージェント自律 OK
- **write tool**（返信・タスク・決定の提案の適用、外部送信 等）= **HITL（Human-in-the-loop）**。提案を生成するだけで、**host が人の承認の背後にゲートすべき**。auto-apply 経路を持たない

tool 入力スキーマは Zod で定義する。write tool には `readOnlyHint: false` を付ける。CLI からも同じサービス層を叩く。

**HITL は host 強制である**（本 ADR の要となる正直化）。`readOnlyHint: false` は MCP の *advisory*（非拘束）な annotation であり、server 自身は「人の承認が無い限り write を実行しない」を強制しない —— tool を呼べば handler は即座に走る。ゆえに HITL の実効は host（Claude Code / Desktop 等）が承認 UI でゲートすることに依存する。auto-approve に設定した host は人を介さず write / 外部送信 / 不可逆破棄まで実行しうる。この非強制性は **MCP を境界に選んだこと自体に内在**する（server が保持できる「人の保証」は MCP には存在しない）。tool 記述も「requires human approval」ではなく「hosts must gate behind human approval」と表現する。

## Consequences

### Positive

- エージェントは安全に read を自律実行でき、危険な write は人がゲートする
- 「提案 → 承認 → 適用」が一貫した HITL ループになる（[ADR-0008](0008-assistant-skills.md) の skill 群もこの境界に乗る）

### Negative / Trade-offs

- 完全自律の「実行まで」体験は提供しない（意図的な制約）
- **HITL は server 側で強制できない**（host 強制）。`readOnlyHint: false` は advisory な annotation にすぎず、server は承認の有無を検査せずに write を実行する。したがって「auto-apply 経路を持たない」は *server が auto-apply の経路を用意しない* という意味であり、*host が人を介さず実行することを server が防ぐ* という保証ではない。この制約は MCP を境界に選んだ帰結であり、既定の host 構成では HITL は機能する。
- **記録された「却下」の下流強制は限定的**（本 ADR の enforcement 内）。`propose.apply` / `propose.batch` は proposals ledger を参照し、`rejected` 済み候補の再適用を `REJECTED_CANDIDATE` エラーで拒否する（監査自己矛盾の防止）。ただし現行 host が承認を得ずに write を呼ぶこと自体は上記のとおり防げない。

### Defense-in-depth（elicitInput・任意・client 依存）

不可逆 / egress の write 部分集合（`source.forget` / `propose.apply` の `publish:true` / `task.publish` / `task.act` / `person.merge`）に限り、**client が elicitation capability を advertise する場合にのみ** server 側から `elicitInput` 確認往復を挟む。これは auto-approve 構成に対する「敷居上げ」であって、**server 強制の人の保証ではない**（elicitation 応答も client 側で生成されるため、auto-answer する host は迂回しうる —— MCP に server 保持の人の保証は無い、という上記の帰結と一致）。client が capability 非対応の場合は現行動作（proceed）にフォールバックし、接続時（`oninitialized`）に一度だけ警告を stderr に出す。実装は `src/mcp/elicit.ts`。

## Alternatives Considered

- エージェントに write を自律させる（auto-apply） → 却下。local-first/privacy/信頼の姿勢（[ADR-0003](0003-local-first-and-content-minimization.md)）に反する
- 独自 RPC / REST 境界 → 却下。消費者は MCP エージェントなので MCP が自然
