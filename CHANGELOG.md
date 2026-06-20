# Changelog

## [0.1.10](https://github.com/ozzy-labs/suasor/compare/v0.1.9...v0.1.10) (2026-06-20)


### Bug Fixes

* **build:** Docker build の postinstall 失敗を修正（scripts/ を install 前に COPY） ([#183](https://github.com/ozzy-labs/suasor/issues/183)) ([b4e06b4](https://github.com/ozzy-labs/suasor/commit/b4e06b438e7cecbd5f0d2dde4371b2181fdbb03a))

## [0.1.9](https://github.com/ozzy-labs/suasor/compare/v0.1.8...v0.1.9) (2026-06-20)


### Features

* **cli:** `search` / `brief` 実行時に embedding disabled のインラインヒント ([#168](https://github.com/ozzy-labs/suasor/issues/168)) ([adf7461](https://github.com/ozzy-labs/suasor/commit/adf74619da3b7cc067bc0031e0c0c1dc04bd230c))
* **cli:** `suasor config show --effective`（実効設定の確認、secret マスク） ([#179](https://github.com/ozzy-labs/suasor/issues/179)) ([ccbd50f](https://github.com/ozzy-labs/suasor/commit/ccbd50fffc1ef70c10b3ea822442f35ed7ae289a))
* **cli:** doctor に「token 保存済みだが connector 未有効」検出を追加 ([#172](https://github.com/ozzy-labs/suasor/issues/172)) ([557da32](https://github.com/ozzy-labs/suasor/commit/557da326c3d8d0ac24988a004db39ac0dcbc0ece))
* **cli:** init 出力をネクストステップ多段化 ([#169](https://github.com/ozzy-labs/suasor/issues/169)) ([2bf5e93](https://github.com/ozzy-labs/suasor/commit/2bf5e931e1878bb3f87f2c8a8cc87737670eacab))
* **cli:** suasor onboard 対話セットアップウィザード (ADR-0029) ([#176](https://github.com/ozzy-labs/suasor/issues/176)) ([6eba077](https://github.com/ozzy-labs/suasor/commit/6eba077fb9ba786cb8055c73a93c72b19d4ca910))
* **cli:** suasor sync — 全 connector 一括 one-shot + 定期実行委譲 ※ADR 先行 ([#149](https://github.com/ozzy-labs/suasor/issues/149)) ([3384ccf](https://github.com/ozzy-labs/suasor/commit/3384ccf934b1f69a115e97074495cf4b4cdfbc8a))
* **connectors:** slack not_in_channel per-channel warn + conversations joined mark ([#180](https://github.com/ozzy-labs/suasor/issues/180)) ([aa2a8d5](https://github.com/ozzy-labs/suasor/commit/aa2a8d54e326b3b97b32905302f9b2ea2c953e49))
* **mcp:** task due date / priority + overdue surfacing (ADR-0028) ([#151](https://github.com/ozzy-labs/suasor/issues/151)) ([ba78f26](https://github.com/ozzy-labs/suasor/commit/ba78f26c432717c80f77920f8c30c834fef7f6b0))
* **skills:** weekly-review / commitment-chase — active surface skills ([#152](https://github.com/ozzy-labs/suasor/issues/152)) ([fd5f329](https://github.com/ozzy-labs/suasor/commit/fd5f3299e8111b9848a5cdb777ac80e4e70536d5))


### Bug Fixes

* **cli:** standalone binary 非対応コマンドの専用エラー化 ([#175](https://github.com/ozzy-labs/suasor/issues/175)) ([35f0e41](https://github.com/ozzy-labs/suasor/commit/35f0e417b711ff08f8a002f8dbac9fcdc955fddf))
* **config:** per-connector スキーマを loadConfig 検証へ配線 ([#177](https://github.com/ozzy-labs/suasor/issues/177)) ([836bcef](https://github.com/ozzy-labs/suasor/commit/836bceff1449b60a2e4d4617ee61edbb56736386))
* **connectors:** Slack `since` を config ロード時に検証（無音 no-floor を解消） ([#170](https://github.com/ozzy-labs/suasor/issues/170)) ([e056d9a](https://github.com/ozzy-labs/suasor/commit/e056d9ac9d85894a2d2692582dcf80e0e6c3a220))
* **connectors:** Slack channel 非 ID 値を warn + `slack conversations` に ID/Name 列 ([#174](https://github.com/ozzy-labs/suasor/issues/174)) ([dcf83c4](https://github.com/ozzy-labs/suasor/commit/dcf83c440fd0dca18630516cb37488442872d392))
* **connectors:** slack multi-ws partial failure summary + exit 1 ([#181](https://github.com/ozzy-labs/suasor/issues/181)) ([7c2d978](https://github.com/ozzy-labs/suasor/commit/7c2d97888284ceec12732efd90ac51562b1e9d78))

## [0.1.8](https://github.com/ozzy-labs/suasor/compare/v0.1.7...v0.1.8) (2026-06-20)


### Features

* **export:** draft.export — local draft export tool (ADR-0025 PR1/2) ([#135](https://github.com/ozzy-labs/suasor/issues/135)) ([2176381](https://github.com/ozzy-labs/suasor/commit/2176381b38b5507cfab597abd58574b2b4ff305f))
* **export:** Office 形式 export — md→docx/pptx/xlsx composition サイドカー ([#138](https://github.com/ozzy-labs/suasor/issues/138) PR1/2) ([#139](https://github.com/ozzy-labs/suasor/issues/139)) ([4ad1093](https://github.com/ozzy-labs/suasor/commit/4ad1093d13559cc6b5a20bdccf3606e17b22732e))
* **mcp:** source.forget — local purge + event redaction (ADR-0026) ([#145](https://github.com/ozzy-labs/suasor/issues/145)) ([f334fac](https://github.com/ozzy-labs/suasor/commit/f334facc7714e4e84a620559443d55699b25eea4))
* **retrieval:** search フィルタ + hybrid (FTS×vec RRF 融合) ([#144](https://github.com/ozzy-labs/suasor/issues/144)) ([a61f99e](https://github.com/ozzy-labs/suasor/commit/a61f99e14284b82db0f853c9d74ddde765eb7f53))
* **skills:** wire draft.export into draft-producing skills (ADR-0025 PR2/2) ([#137](https://github.com/ozzy-labs/suasor/issues/137)) ([218c350](https://github.com/ozzy-labs/suasor/commit/218c3506c393102ab1c4ad579534c62715942803))

## [0.1.7](https://github.com/ozzy-labs/suasor/compare/v0.1.6...v0.1.7) (2026-06-20)


### Features

* **cli:** suasor brief — period bundle for scheduled / non-interactive use ([#118](https://github.com/ozzy-labs/suasor/issues/118)) ([d0d5826](https://github.com/ozzy-labs/suasor/commit/d0d5826e22062cb0447116a03a36ce61df604f4f))
* **cli:** suasor doctor — aggregate health check (config/db/embedding/connectors) ([#119](https://github.com/ozzy-labs/suasor/issues/119)) ([9195057](https://github.com/ozzy-labs/suasor/commit/91950579cb26bf6efd8d69d7cf72326bf76e7e0a))
* **extraction:** [extraction] config + markitdown thin client (ADR-0024 PR1/4) ([#128](https://github.com/ozzy-labs/suasor/issues/128)) ([7c76f10](https://github.com/ozzy-labs/suasor/commit/7c76f1005bbf1b0ede1616f208c469993af82b98))
* **extraction:** extraction_meta + drift re-extraction + extraction status (ADR-0024 PR3/4) ([#130](https://github.com/ozzy-labs/suasor/issues/130)) ([ff6697f](https://github.com/ozzy-labs/suasor/commit/ff6697fffea2fbcfe935bd0f551cd2bce2678257))
* **extraction:** sync wiring — extract Office/PDF bodies at ingest (ADR-0024 PR2/4) ([#129](https://github.com/ozzy-labs/suasor/issues/129)) ([33bf35b](https://github.com/ozzy-labs/suasor/commit/33bf35bf48cb77442288ec2ccef228f62a864066))
* **mcp:** source.history read tool + doc-diff skill ([#121](https://github.com/ozzy-labs/suasor/issues/121)) ([#125](https://github.com/ozzy-labs/suasor/issues/125)) ([4d55794](https://github.com/ozzy-labs/suasor/commit/4d557948ea6e8b9bd4046551291fb7fda73247fc))
* **mcp:** task.update — task lifecycle state transition + task-update skill ([#117](https://github.com/ozzy-labs/suasor/issues/117)) ([c44841c](https://github.com/ozzy-labs/suasor/commit/c44841c1e528ceb86097630a5a8f0b43121e365b))
* **skills:** add commitment-review / proposal-review / person-cleanup ([#114](https://github.com/ozzy-labs/suasor/issues/114)) ([2b8f98b](https://github.com/ozzy-labs/suasor/commit/2b8f98b92539cf13cb8864408dfa3fa1c891cd8b))
* **skills:** add slack-triage / provenance-trace (Tier B) ([#116](https://github.com/ozzy-labs/suasor/issues/116)) ([2161311](https://github.com/ozzy-labs/suasor/commit/21613119e9ffd3beafac40511bcc8e113b2aa6ea))
* **skills:** doc-review — 仕様/設計書のレビュー skill ([#123](https://github.com/ozzy-labs/suasor/issues/123)) ([#132](https://github.com/ozzy-labs/suasor/issues/132)) ([0b8ef35](https://github.com/ozzy-labs/suasor/commit/0b8ef358b16b6b9861db6fc527dcddbfbc0aa0b8))
* **skills:** plan-draft — issue/設計の分解・計画 skill ([#122](https://github.com/ozzy-labs/suasor/issues/122)) ([#126](https://github.com/ozzy-labs/suasor/issues/126)) ([467dab3](https://github.com/ozzy-labs/suasor/commit/467dab3f4d23cf02036c4cc4817dbb6cef743c0d))

## [0.1.6](https://github.com/ozzy-labs/suasor/compare/v0.1.5...v0.1.6) (2026-06-20)


### Features

* **cli:** embeddings 保守 CLI — status / rebuild / drain / find-duplicates ([#107](https://github.com/ozzy-labs/suasor/issues/107)) ([35bcb6c](https://github.com/ozzy-labs/suasor/commit/35bcb6c3252f88956ea56981fed3a8e6936a4285))
* **cli:** introspection verbs — connectors list / mcp tools ([#100](https://github.com/ozzy-labs/suasor/issues/100)) ([2735c4b](https://github.com/ozzy-labs/suasor/commit/2735c4b7cdc4716fa72e889df4e2cc25a96aea2b))
* **commitment:** commitment 台帳 (scan/list/resolve/dismiss/reopen) ([#111](https://github.com/ozzy-labs/suasor/issues/111)) ([bd7e3d2](https://github.com/ozzy-labs/suasor/commit/bd7e3d206dd8a4e656878c9d7e5d3f3bb94b2384))
* **connectors:** add generic local filesystem connector (ADR-0023) ([#110](https://github.com/ozzy-labs/suasor/issues/110)) ([9b97643](https://github.com/ozzy-labs/suasor/commit/9b9764347222f04395a3bf38cb4c564fa012ba5b))
* **connectors:** 非 Slack connector の auth set / auth test CLI (github/ms-graph/google/box) ([#101](https://github.com/ozzy-labs/suasor/issues/101)) ([e5a1d0c](https://github.com/ozzy-labs/suasor/commit/e5a1d0cf62c5a2edfe0d6b0bc61801fadbac463b))
* **github:** sync に notifications 取り込みを追加 ([#106](https://github.com/ozzy-labs/suasor/issues/106)) ([b77e4d5](https://github.com/ozzy-labs/suasor/commit/b77e4d533c73366340c7e338cd984015abc19441))
* **mcp:** graph.expand に direction パラメータ追加 (graph.trace 相当, ADR-0020) ([#105](https://github.com/ozzy-labs/suasor/issues/105)) ([6c06add](https://github.com/ozzy-labs/suasor/commit/6c06add0101c5fe75d02caddc95da11064ff9f73)), closes [#97](https://github.com/ozzy-labs/suasor/issues/97)
* **mcp:** person identity resolution — person.list/merge/split (HITL) ([#108](https://github.com/ozzy-labs/suasor/issues/108)) ([d02d4a2](https://github.com/ozzy-labs/suasor/commit/d02d4a2bcad6f803627cac7b068922c1116439db))
* **mcp:** propose ライフサイクル補完 — propose.list / propose.reject ([#103](https://github.com/ozzy-labs/suasor/issues/103)) ([836afed](https://github.com/ozzy-labs/suasor/commit/836afeda163a4eb345f32ae20b9659756ff40de5))
* **mcp:** write tools — decision.record / inbox.add / inbox.triage (HITL) ([#102](https://github.com/ozzy-labs/suasor/issues/102)) ([3d0242e](https://github.com/ozzy-labs/suasor/commit/3d0242e62c0887ea3cf69c284c6e8acd6a845a6d))
* **mcp:** 手動リンク CRUD — link.add / link.remove (HITL) ([#104](https://github.com/ozzy-labs/suasor/issues/104)) ([5d4b69a](https://github.com/ozzy-labs/suasor/commit/5d4b69ac863c32aa9b63e2faccb0d6ae0fd5bafa))
* **slack:** CLI UX 改善 — status 可読化 + conversations 進捗表示 ([#98](https://github.com/ozzy-labs/suasor/issues/98)) ([7259e87](https://github.com/ozzy-labs/suasor/commit/7259e8788d28dd93c13ba68a91ebe8d4064df949))

## [0.1.5](https://github.com/ozzy-labs/suasor/compare/v0.1.4...v0.1.5) (2026-06-19)


### Features

* **slack:** rate-limit retry for fetch paths (Retry-After, ADR-0019) ([#81](https://github.com/ozzy-labs/suasor/issues/81)) ([5b8e3e4](https://github.com/ozzy-labs/suasor/commit/5b8e3e40e7f8fadc2ea99bfc552e24a2329ca624))

## [0.1.4](https://github.com/ozzy-labs/suasor/compare/v0.1.3...v0.1.4) (2026-06-19)


### Features

* **mcp:** brief period-bundle read tool (ADR-0017) ([#75](https://github.com/ozzy-labs/suasor/issues/75)) ([65b34dc](https://github.com/ozzy-labs/suasor/commit/65b34dcd7bb3409a1d4eb3f249006f0029890bc6))
* **mcp:** knowledge-graph traversal tools graph.related/graph.expand (ADR-0018) ([#77](https://github.com/ozzy-labs/suasor/issues/77)) ([f0f232c](https://github.com/ozzy-labs/suasor/commit/f0f232c80eafcfb4280d24afdac621d262cb4dce))


### Bug Fixes

* **slack:** resolve DM names, sort conversations a-z, add sync progress ([#78](https://github.com/ozzy-labs/suasor/issues/78)) ([34ddef6](https://github.com/ozzy-labs/suasor/commit/34ddef67c5762c5044598bf3a88eb5c0970a9eb3))

## [0.1.3](https://github.com/ozzy-labs/suasor/compare/v0.1.2...v0.1.3) (2026-06-19)


### Bug Fixes

* derive --version from package.json + sync stale version pins ([#73](https://github.com/ozzy-labs/suasor/issues/73)) ([f334d0f](https://github.com/ozzy-labs/suasor/commit/f334d0f0f120f8e2b297000138c1473bacf7d183))

## [0.1.2](https://github.com/ozzy-labs/suasor/compare/v0.1.1...v0.1.2) (2026-06-19)


### Bug Fixes

* **release:** v-prefixed tags (no component) + robust docker version ([#67](https://github.com/ozzy-labs/suasor/issues/67)) ([773f4f1](https://github.com/ozzy-labs/suasor/commit/773f4f1da2b89925ba004e6e2a8ec0351e866459))

## [0.1.1](https://github.com/ozzy-labs/suasor/compare/suasor-v0.1.0...suasor-v0.1.1) (2026-06-19)


### Features

* **cli:** clipanion CLI skeleton ([#21](https://github.com/ozzy-labs/suasor/issues/21)) ([104c318](https://github.com/ozzy-labs/suasor/commit/104c318207dd662682c362dc9e13eaf423fe666c))
* **connectors:** contract + first connector (GitHub) ([#23](https://github.com/ozzy-labs/suasor/issues/23)) ([8f0f308](https://github.com/ozzy-labs/suasor/commit/8f0f308daf17ededd31d517104e08db94dbfa8f1))
* **connectors:** Slack/Graph/Google/Box/Web connectors ([#29](https://github.com/ozzy-labs/suasor/issues/29)) ([600ed3e](https://github.com/ozzy-labs/suasor/commit/600ed3e240910e5295c457aff518319e73e22034))
* **db:** event store + projections + rebuild ([#18](https://github.com/ozzy-labs/suasor/issues/18)) ([602ab95](https://github.com/ozzy-labs/suasor/commit/602ab958b5494e6ee5bd3ba61c29976d6df06115))
* **dist:** npm + single binary + Docker(+Ollama) + MCP registry ([#33](https://github.com/ozzy-labs/suasor/issues/33)) ([f336d40](https://github.com/ozzy-labs/suasor/commit/f336d40f58073086e5c1b47fab02884ad881b2fc)), closes [#15](https://github.com/ozzy-labs/suasor/issues/15)
* **mcp:** MCP stdio server + read tools ([#22](https://github.com/ozzy-labs/suasor/issues/22)) ([51e1839](https://github.com/ozzy-labs/suasor/commit/51e18391261ca11385a4da7f435b3651682f4130))
* **propose:** HITL propose.generate/apply + task.create write tools ([#26](https://github.com/ozzy-labs/suasor/issues/26)) ([0dc723a](https://github.com/ozzy-labs/suasor/commit/0dc723a990d58f4feb598b68948d82e490f97f77))
* **retrieval:** FTS5 search service (FTS-first) ([#20](https://github.com/ozzy-labs/suasor/issues/20)) ([8af5b1e](https://github.com/ozzy-labs/suasor/commit/8af5b1eba876464ff9c2262bc49e3af1b5d053be))
* **retrieval:** Ollama embedding backend + graceful degrade ([#27](https://github.com/ozzy-labs/suasor/issues/27)) ([538f3ee](https://github.com/ozzy-labs/suasor/commit/538f3ee569d5eb115c481cb13ee0d1bb399a68c5))
* **skills:** suasor skills install/list + dogfood drift check ([#28](https://github.com/ozzy-labs/suasor/issues/28)) ([ed2b5a7](https://github.com/ozzy-labs/suasor/commit/ed2b5a7430c3bbf45100500d2c75c0ab08193d1f))
* **slack:** demand digest + slack.demand.list MCP tool ([#61](https://github.com/ozzy-labs/suasor/issues/61)) ([9a4e854](https://github.com/ozzy-labs/suasor/commit/9a4e8547c8d34640ac327ece3be5a56425f13b48))
* **slack:** engagement axis (conversations --sort=last_self_post) ([#60](https://github.com/ozzy-labs/suasor/issues/60)) ([ce8a95e](https://github.com/ozzy-labs/suasor/commit/ce8a95e487f41401aada96137e322f1a9e9a5a4b))
* **slack:** ingest thread replies (conversations.replies) ([#59](https://github.com/ozzy-labs/suasor/issues/59)) ([2200494](https://github.com/ozzy-labs/suasor/commit/2200494fe47ad6636a5e1573da4d43504ab81d81))
* **slack:** isolate mid-fetch failures per workspace ([#56](https://github.com/ozzy-labs/suasor/issues/56)) ([#62](https://github.com/ozzy-labs/suasor/issues/62)) ([f7e1285](https://github.com/ozzy-labs/suasor/commit/f7e1285f3a2c302d38a4e39d2725b8ba8a828a93))
* **slack:** multi-workspace ingest ([connectors.slack.workspaces.&lt;alias&gt;]) ([#55](https://github.com/ozzy-labs/suasor/issues/55)) ([1970399](https://github.com/ozzy-labs/suasor/commit/19703999da28345e8de2e9e718ec9230b65fd2cb))
* **slack:** operational verbs (auth test / conversations) + per-channel cursor ([#47](https://github.com/ozzy-labs/suasor/issues/47)) ([7d7cb4e](https://github.com/ozzy-labs/suasor/commit/7d7cb4e683e337b59583ebc33707627d8b781a9f))
* **slack:** per-channel since override + cursor backfill verb ([#57](https://github.com/ozzy-labs/suasor/issues/57)) ([#63](https://github.com/ozzy-labs/suasor/issues/63)) ([47dd379](https://github.com/ozzy-labs/suasor/commit/47dd37986a15128826dee33f2654f1e3fc092881))
* **slack:** sync date floor + cursor status/reset verbs ([#58](https://github.com/ozzy-labs/suasor/issues/58)) ([911eb7e](https://github.com/ozzy-labs/suasor/commit/911eb7e6419475a152d2a67c7f6642a0a2d5d253))


### Bug Fixes

* align Box body and fingerprint to filename-only ingest ([#39](https://github.com/ozzy-labs/suasor/issues/39)) ([314c967](https://github.com/ozzy-labs/suasor/commit/314c96750f87eab62013d4374409d15e432a90f5))
* exclude compiled binary from the npm package ([#42](https://github.com/ozzy-labs/suasor/issues/42)) ([0282479](https://github.com/ozzy-labs/suasor/commit/02824794bc7c060623b90329ac6b65134405f962))
* normalize bin path so npm keeps the suasor command ([#43](https://github.com/ozzy-labs/suasor/issues/43)) ([b09fb7e](https://github.com/ozzy-labs/suasor/commit/b09fb7e9676e3b1155fef24069532441f47803e5))
