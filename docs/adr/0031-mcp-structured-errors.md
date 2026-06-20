# 0031. MCP structured errors (code/hint) + startup config readiness

- Status: Proposed
- Date: 2026-06-21
- Deciders: Suasor maintainers
- Related: [ADR-0004](0004-mcp-agent-boundary-and-hitl.md)（MCP = agent boundary / HITL write）, [ADR-0025](0025-local-draft-export.md)（`draft.export` / `[export].dir` sandbox）, [ADR-0007](0007-connector-contract.md)（connector 契約 — no silent wrong answer）, [ADR-0029](0029-onboarding-wizard.md)（onboarding wizard / config scaffold）
- Tracks: #196 / Phase 3 / Epic #185

## Context

MCP の write tool エラーは **bare string** で返っており（`src/mcp/server.ts` 各ハンドラの `{ isError: true, content: [{ text: error.message }] }`）、machine-readable な `code` も actionable な `hint` も持たない。host（Claude Code / Desktop 等）は次を区別できない:

- **入力エラー**（self-loop link / self-merge 等）
- **状態違反**（`open` でない inbox item の triage 等）
- **エンティティ欠落**（未知の link id / inbox item / person identity）
- **設定エラー**（`[export].dir` 未設定 / DB path 未設定）

区別できないと host は「ユーザーに何を直させればよいか」を案内できず、すべて「謎のエラー」になる。

さらに `draft.export` は `[export].dir` 未設定を **呼び出し時に初めて** `throw new Error(...)` で失敗していた（`src/mcp/server.ts`）。これは fail-fast 違反であると同時に、設定欠落が bare string で host から区別不能なまま表面化する二重の問題だった。config / DB 欠落の起動時エラーも stderr のみで、host からは「サーバーが黙って死んだ」ようにしか見えない。

## Decision

**MCP tool エラーに小さく安定した構造 `{ code, message, hint }` を与え、起動時に critical config（DB path）を検証して fail-fast する。**

### 1. エラー code 体系（`src/mcp/errors.ts` 新設）

`McpErrorCode` を SSOT として定義する。安定文字列で host が branch するため、改名は破壊的変更:

| code | 意味 | 例 |
|---|---|---|
| `INVALID_INPUT` | Zod schema を超えた入力不正 | self-loop link / self-merge / 不正 filename |
| `INVALID_STATE` | エンティティは在るが遷移不可 | `open` でない inbox item の triage |
| `MISSING_ENTITY` | 参照先が存在しない | 未知の link id / inbox item / person identity |
| `EXPORT_DIR_NOT_CONFIGURED` | `draft.export` で `[export].dir` 未設定 | — |
| `CONFIG_INVALID` | critical config 欠落/不正（boot or call） | `storage.dbPath` 未設定 |
| `UNKNOWN_CONNECTOR` | `connector.sync` で未登録 connector | — |
| `INTERNAL` | 上記に当てはまらない想定外失敗 | fallback |

### 2. 返却形 `{ code, message, hint }`

- 成功の `jsonResult`（JSON を 1 つの text content に詰める）と対称に、エラーは `toolError(body)` で **`isError: true` + JSON body を 1 つの text content** に詰める。host は `JSON.parse` して `code` で branch でき、`message` は素の text しか見ない host 向けに human-readable に残す。
- `message` は何が起きたか、`hint` は **どう直すか**（次アクション）を持つ。`hint` は任意。
- ドメインエラーは `McpToolError(code, message, hint)` を throw でき、`toToolError(error)` が `McpToolError` → そのまま、他 `Error` → `INTERNAL` に degrade する（クラッシュで接続を切らず、必ず構造化 tool error として表面化）。

read tool は副作用なし＝throw しないため code は不要（[ADR-0004](0004-mcp-agent-boundary-and-hitl.md) の read/write 構造的分離をそのまま踏襲）。本 ADR は write 半分 + boot を対象にする。

### 3. 起動時 readiness 検証（`verifyReadiness` / `serveMcp`）

- `serveMcp` 起動時に `verifyReadiness(config)` で critical config を検証し、`ReadinessIssue[]`（空＝ready）を得る。**致命的**は今のところ:
  - `storage.dbPath` 未設定 → store を開けない → `CONFIG_INVALID`（hint: `[storage].dbPath` を設定、`suasor onboard` で scaffold）
- 致命があれば全件を stderr（診断、JSON-RPC stream には絶対書かない）に code + hint 付きで出し、先頭を `McpToolError` として throw して fail-fast する。
- `[export].dir` は **致命にしない**: `draft.export` という任意の 1 write tool だけが使うため、未設定はサーバー全体を止めず per-call の `EXPORT_DIR_NOT_CONFIGURED` に degrade する（[ADR-0025](0025-local-draft-export.md) の sandbox は optional feature）。

## Consequences

### Positive

- host が `code` で「入力 / 状態 / 欠落 / 設定 / connector」を機械的に分岐でき、`hint` で具体的な次アクションを提示できる。
- 設定欠落が **起動時に** code + hint 付きで fail-fast する（`[export].dir` だけは per-call degrade）。fail-fast 違反を解消。
- `toToolError` が想定外 `Error` も `INTERNAL` に包むため、ハンドラのクラッシュで stdio 接続が落ちず、host に構造化エラーとして見える。
- 成功 (`jsonResult`) / 失敗 (`toolError`) が対称な「JSON-in-text-content」形式で揃い、host のパースが一様になる。

### Negative / Trade-offs

- `McpErrorCode` は安定 API になる（改名 = 破壊的変更）。新 code 追加時は本 ADR の表と `docs/design/mcp-surface.md` を更新する規約コスト。
- エラー分類を message 文字列の部分一致（`startsWith("unknown connector")` / `includes("not found")` 等）で行う箇所がある。サービス側が将来 `code` 付き専用エラー型を投げるよう揃えればより堅牢だが、本 ADR の scope では最小侵襲を優先する。

## Alternatives Considered

- **JSON-RPC error（`McpError` / プロトコルレベル error）で返す**: tool 実行の失敗は MCP では「正常に `isError: true` を返す」のが規約（プロトコル error はトランスポート/プロトコル層の異常用）。host の auto-approve / 表示フローとも整合するため不採用。
- **`[export].dir` も起動時致命にする**: `draft.export` を使わない大多数の構成でサーバーが起動不能になり過剰。per-call degrade を採用。
- **エラー型ごとにサービス側へ `code` を一斉付与**: より堅牢だが変更面積が大きく、本 Issue の scope（MCP 境界の構造化）を超える。将来 follow-up に委ねる。
