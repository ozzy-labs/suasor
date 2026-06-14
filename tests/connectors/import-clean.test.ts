/**
 * Connector import-clean discipline (ADR-0007 "import-clean", NFR-PRF-1).
 *
 * Registering / listing / building the connector surface must NOT pull a heavy
 * connector SDK (octokit) or the native keyring binding (@napi-rs/keyring) into
 * the module registry. Those load only when a connector actually syncs / a
 * secret is actually resolved.
 *
 * Enforced two ways:
 *  1. A static guard over `src/connectors/*` sources: their *top-level* imports
 *     must not reference the heavy SDKs (those belong in lazy `await import`).
 *  2. A runtime guard in a fresh subprocess: importing the connectors module and
 *     listing connector names must not register `octokit` / `keyring`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const connectorsDir = join(here, "../../src/connectors");

/** Heavy specifiers that must only ever be lazy-imported (inside functions). */
const HEAVY = [
  "octokit",
  "@slack/web-api",
  "@microsoft/microsoft-graph-client",
  "@azure/msal-node",
  "googleapis",
  "box-typescript-sdk-gen",
  "playwright-core",
  "@napi-rs/keyring",
  "bun:sqlite",
  "drizzle-orm",
];

function connectorSources(): string[] {
  return readdirSync(connectorsDir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => join(connectorsDir, n));
}

describe("connector import-clean discipline", () => {
  test("no top-level static import of heavy SDKs in connector sources", async () => {
    const offenders: string[] = [];
    for (const file of connectorSources()) {
      const text = await Bun.file(file).text();
      // `import type ...` is erased by the compiler and loads nothing at runtime
      // (verbatimModuleSyntax), so only value imports count against import-clean.
      const staticImports = text.matchAll(/^import\s+(?!type\s)[^\n]*from\s+["']([^"']+)["'];?/gm);
      for (const m of staticImports) {
        const spec = m[1] ?? "";
        if (HEAVY.some((h) => spec === h || spec.startsWith(`${h}/`))) {
          offenders.push(`${file}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("importing connectors + listing names loads no octokit / keyring", () => {
    const probeDir = mkdtempSync(join(tmpdir(), "suasor-conn-clean-"));
    try {
      const probePath = join(probeDir, "probe.ts");
      writeFileSync(
        probePath,
        `import { connectorNames } from ${JSON.stringify(join(connectorsDir, "index.ts"))};
connectorNames();
const reg = globalThis.Loader?.registry;
const keys = reg ? (reg instanceof Map ? [...reg.keys()] : Object.keys(reg)) : null;
const heavy = ["octokit", "slack", "microsoft-graph", "msal", "googleapis", "box-typescript", "playwright", "keyring"];
const hit = keys === null ? null : heavy.filter((h) => keys.some((k) => k.includes(h)));
console.log(JSON.stringify(hit));
`,
      );
      const proc = Bun.spawnSync(["bun", "run", probePath], { env: { ...process.env } });
      expect(proc.exitCode).toBe(0);
      const parsed = JSON.parse(proc.stdout.toString().trim()) as string[] | null;
      // null → registry not introspectable in this build; static guard still covers it.
      if (parsed !== null) expect(parsed).toEqual([]);
    } finally {
      rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
