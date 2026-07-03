<!-- begin: ozzy-labs/commons -->

# Contributing

This is a personal project maintained by [ozzy-labs](https://github.com/ozzy-labs). External contributions are not currently accepted.

## Bug Reports & Feature Requests

If you find a bug or have an idea for improvement, please open an issue.

## License

By interacting with this project, you agree that any contributions you make will be licensed under the [MIT License](LICENSE).

<!-- end: ozzy-labs/commons -->

## Documentation

- **Keep `README.md` and `README.ja.md` in sync.** When you change one, update the other in the **same PR** — the connector list, CLI command/flag enumerations, and the install (Bun version) instructions must match across both. The two files cross-reference each other ([English →] / [日本語 →]), so a one-sided edit silently diverges the EN/JA quickstart.
- **Follow the guide language policy (English setup funnel; Japanese deep-dives).** The setup funnel is normalized to **English as the canonical source** so that a reader coming from the English README does not hit a dead end: `README.md`, `docs/guide/install.md`, `docs/guide/connectors.md`, and `docs/guide/troubleshooting.md`. The deeper guides (`embedding.md` / `extraction.md` / `export.md` / `scheduling.md` / `skills.md` / `data-audit.md`) stay **Japanese** to avoid the standing cost of maintaining a full translation in two languages. When you touch a canonical funnel doc, keep the technical tokens verbatim across languages — commands, config keys, ADR/Issue links, code blocks, and identifiers must match — and translate prose only. If a change to a canonical source affects a doc that has a translation or summary elsewhere (e.g. `README.ja.md`), update that translation/summary in the **same PR** so the two never drift.
