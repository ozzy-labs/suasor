# 0025. ローカル下書き export（draft.export・送信しない）

- Status: Proposed
- Date: 2026-06-20
- Deciders: Suasor maintainers
- Related: [ADR-0003](0003-local-first-and-content-minimization.md)（local-first / content-min）, [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP+HITL）, [ADR-0002](0002-event-sourced-architecture.md)（event-sourced）, [ADR-0007](0007-connector-contract.md)（connector 契約）, [ADR-0009](0009-multi-agent-neutrality.md)（multi-agent 中立）, [ADR-0023](0023-local-filesystem-connectors.md)（local connector）, [ADR-0006](0006-ml-delegation.md)（ML 委譲）
- Tracks: #133

> Status: **Proposed**。本 ADR はレビュー用ドラフト。Accepted 後に実装 PR（event+config+tool → skill 連携）へ進む。Office 形式（docx/xlsx/pptx）export は composition サイドカーで段階化（別 Issue）。

## Context

Suasor は下書き**テキスト**を作る（`reply-draft`＝`ReplyDraftProposed` / `handoff-draft` / `announcement-draft` / `external-brief` / `plan-draft` 等）が、それを**ファイルとして書き出す経路が無い**。ユーザーは手でコピペするしかない。

「ローカルにファイルとして書き出す（**送信はしない**）」は既存不変条件と整合する:

- [ADR-0003](0003-local-first-and-content-minimization.md) §3「**送信・書き込みは人の承認を要する**」→ HITL なローカル書き込みは想定内。§1（本文はローカル保持）とも一致
- [ADR-0004](0004-mcp-agent-boundary-and-hitl.md): write tool は「外部送信 等の副作用付き HITL」→ local 書き込みも write/HITL に収まる
- [ADR-0009](0009-multi-agent-neutrality.md) / FR-MCP-2: 同一 MCP surface を全 host で。Write tool を持たない host（Codex/Gemini/Copilot）でも下書きをファイル化できる＝**MCP tool で提供する正当化**（host の file write に依存しない）

ただし新しい副作用カテゴリ（**event store / source の外**のローカルファイル書き込み）を導入するため、境界を本 ADR で明文化する。

## Decision（ドラフト・レビュー対象）

**下書きを「設定したローカル export ディレクトリ」に書き出す HITL write tool `draft.export` を導入する。送信しない・source に書き戻さない・sandbox 制約・body-less 監査 event。**

1. **local export のみ** — 外部 SaaS 送信・connector source への書き戻しはしない（[ADR-0003](0003-local-first-and-content-minimization.md) §2/§3・[ADR-0007](0007-connector-contract.md) を維持）。egress なし。
2. **`draft.export`（write / HITL）** — `{ content, filename, format: "md" | "txt", sourceExternalId? }` を受け、`[export].dir` 配下に書き出して path を返す。`readOnlyHint: false`、auto-apply なし（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md)）。Markdown / プレーンテキスト先行。
3. **sandbox 制約** — `[export].dir`（既定 `<configDir>/exports/`）配下のみに書く。`filename` は **basename 扱い**で `[export].dir` 直下に限定し、`/`・`\`・`..`・絶対パスは拒否（path traversal 不可、NFR-PRV）。比較は realpath（絶対パス解決）後に containment 判定する。`[export].dir` が無ければ tool が sandbox 内に作成（mkdir -p 相当）。任意パスへの書き込みは不可。
4. **`local` connector root と重複させない** — `[export].dir` が `[connectors.local].roots` の**配下または一致**だと、書き出した下書きが次の sync で**再取り込みされるフィードバックループ**になる（[ADR-0023](0023-local-filesystem-connectors.md)）。両者を realpath 解決して containment を判定し、重複時は tool error で拒否。既定も roots と被らない場所にする。
5. **body-less 監査 event `DraftExported`**（[ADR-0002](0002-event-sourced-architecture.md)） — `{ path, sourceExternalId?, format, exportedAt }` を append（**body は持たない**）。これで「write tool = event を append」の規律と content-minimization（event に本文を残さない・本文は export ファイルにのみ存在）を両立。projection は持たない（監査ログのみ。reducer は no-op = `ConnectorSyncCompleted` と同じ先例、`src/projections/reducer.ts`）。
   - **順序**: まず**ファイル書き込み → 成功時のみ `DraftExported` を append**（write 失敗時は tool error・event を残さない＝監査の嘘を作らない。append が落ちても orphan ファイルが残るだけで実害最小）。
   - **replay**: 副作用（ファイル書き込み）は再実行せず、reducer の no-op に畳むだけ（`projections rebuild` 後も drift なし）。既存ファイルとの衝突は連番付与（`name.md` → `name-1.md`）で非破壊を既定とする。
6. **Office 形式は段階化** — docx/xlsx/pptx は md→Office の composition サイドカー（markitdown 抽出 [ADR-0024](0024-document-extraction-sidecar.md) の逆方向・thin client・import-clean・[ADR-0006](0006-ml-delegation.md)）で別 Issue。本 ADR の初期スコープは md/txt。

## Consequences

### Positive

- 下書き（返信・引き継ぎ・告知・計画）をファイル化でき、手コピペが不要に
- MCP tool 提供で **全エージェント host が同一手段**で export 可能（[ADR-0009](0009-multi-agent-neutrality.md)）
- local-first / no-egress / source read-only を**すべて維持**（送信・書き戻しなし）
- body-less event で監査可能・content-min 維持・replay 安全（ファイル非再生成）

### Negative / Trade-offs

- Suasor が初めて「event store / source 外のローカルファイル」に書く副作用を持つ（sandbox + HITL で限定）
- export ファイルはユーザー管理（Suasor は GC しない）。`local` connector root との重複は運用注意（拒否で緩和）
- Office 形式は別サイドカーが要る（初期は md/txt のみ）

## Alternatives Considered

- **ホストの Write tool に任せ Suasor は持たない** — 却下。Write tool を持たない host があり surface が不均一（[ADR-0009](0009-multi-agent-neutrality.md) に反する）。sandbox/監査も一元化できない
- **SaaS へ直接作成・送信（Gmail 送信 / Word 作成 API）** — 却下（本 ADR スコープ外）。「外部送信は HITL ユーザー手動」境界（[ADR-0003](0003-local-first-and-content-minimization.md) §3）を緩めることになり、別途慎重な ADR が要る
- **event を一切持たない純粋副作用 tool** — 却下。「write tool = event を append」規律（[ADR-0002](0002-event-sourced-architecture.md)）から外れ監査もできない。body-less event で両立する
- **任意パスへ書ける export** — 却下。NFR-PRV / 安全上、sandbox（`[export].dir`）+ traversal 拒否 + local.roots 重複拒否に限定
