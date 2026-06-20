/**
 * `scripts/postinstall.mjs` — npm install-time Bun advisory.
 *
 * npm runs `postinstall` under Node, so the script is exercised the same way
 * here: spawned with Node and a controlled `PATH` so the "Bun present" /
 * "Bun absent" branches are deterministic regardless of whether the host that
 * runs the test suite happens to have `bun` installed.
 *
 * Contract under test (Issue #155): warn-only, always exit 0; warn when Bun is
 * not detected, stay silent when it is.
 */
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/postinstall.mjs", import.meta.url));
// Absolute path to a real Node (npm runs postinstall under Node). Resolved up
// front so the test's overridden child PATH only governs the script's own `bun`
// lookup, not how we launch Node itself.
const NODE = Bun.which("node");

/** Run the postinstall script under Node with a fully-overridden environment. */
function runPostinstall(env: Record<string, string>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  if (NODE === null) throw new Error("node not found on PATH");
  const proc = Bun.spawnSync([NODE, SCRIPT], {
    env, // intentionally NOT merged with process.env: full control over PATH.
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

/** A PATH dir that contains a real `node` (so the spawn works) but no `bun`. */
function nodeOnlyPathDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "suasor-postinstall-nobun-"));
  // Symlink-free: a tiny wrapper is unnecessary — we only need `node` resolvable,
  // and the spawn already uses an absolute NODE path, so the child's PATH only
  // affects the script's own `bun` lookup. Return an empty dir => no `bun`.
  return dir;
}

/** A PATH dir containing a fake `bun` that prints a version and exits 0. */
function fakeBunPathDir(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), "suasor-postinstall-bun-"));
  const bunPath = join(dir, "bun");
  writeFileSync(bunPath, `#!/bin/sh\necho "${version}"\n`);
  chmodSync(bunPath, 0o755);
  return dir;
}

describe("postinstall.mjs", () => {
  test("warns and exits 0 when Bun is absent from PATH", () => {
    const dir = nodeOnlyPathDir();
    try {
      const { exitCode, stderr } = runPostinstall({ PATH: dir });
      expect(exitCode).toBe(0); // never fail the install
      expect(stderr).toContain("Bun runtime not detected");
      expect(stderr).toContain("bunx @ozzylabs/suasor");
      expect(stderr).toContain("did NOT fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("stays silent and exits 0 when a bun binary is on PATH", () => {
    const dir = fakeBunPathDir("1.1.0");
    try {
      const { exitCode, stderr } = runPostinstall({ PATH: dir });
      expect(exitCode).toBe(0);
      expect(stderr).not.toContain("Bun runtime not detected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SUASOR_SKIP_POSTINSTALL=1 silences the advisory even with no Bun", () => {
    const dir = nodeOnlyPathDir();
    try {
      const { exitCode, stderr } = runPostinstall({ PATH: dir, SUASOR_SKIP_POSTINSTALL: "1" });
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
