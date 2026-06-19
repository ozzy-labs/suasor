# Changelog

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
