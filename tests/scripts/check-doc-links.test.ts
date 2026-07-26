/**
 * `scripts/check-doc-links.mjs` — the relative-link existence gate (#543).
 *
 * The script is spawned exactly the way CI and lefthook run it (`bun
 * scripts/check-doc-links.mjs` with the repo root as cwd), against throwaway git
 * fixtures. Spawning rather than importing is deliberate: the file list comes
 * from `git ls-files`, so the unit under test is "the script pointed at a
 * repository", not a set of helper functions.
 *
 * Contract under test: a resolvable target passes, a missing one fails with the
 * source location + target + reason, fragments are only judged for Markdown
 * targets, and anything the script cannot resolve statically is reported as
 * `unverified` instead of being silently passed or guessed at.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-doc-links.mjs", import.meta.url));
/** The Bun running these tests — the same runtime `bun run lint:links` uses. */
const BUN = process.execPath;

/** Write `files` (path → body) below `root`, creating parent directories. */
function writeAll(root: string, files: Record<string, string>): void {
  for (const [path, body] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
}

/**
 * Run the checker over a throwaway repository built from `files` (path → body).
 * Files are staged but never committed — `git ls-files` reads the index.
 * `untracked` files are written to disk and deliberately left out of the index.
 */
function runOnFixture(
  files: Record<string, string>,
  untracked: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const root = mkdtempSync(join(tmpdir(), "suasor-doc-links-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeAll(root, files);
    execFileSync("git", ["add", "-A"], { cwd: root });
    writeAll(root, untracked);
    const proc = Bun.spawnSync([BUN, SCRIPT], { cwd: root, stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("check-doc-links.mjs — link targets", () => {
  test("passes on links that resolve, and ignores what it does not own", () => {
    const { exitCode, stdout } = runOnFixture({
      "docs/a.md": [
        "# A",
        "",
        "## Section",
        "",
        "[sibling](./b.md)",
        "[up](../README.md)",
        "[dir](../docs/)",
        "[code](../src/x.ts)",
        "[same-file](#section)",
        "[external](https://example.com/nope.md)",
        "[mail](mailto:nobody@example.com)",
        "",
        "```text",
        "[in a fence](./does-not-exist.md)",
        "```",
        "",
        "`[in code](./does-not-exist.md)`",
        "",
      ].join("\n"),
      "docs/b.md": "# B\n",
      "README.md": "# R\n",
      "src/x.ts": "export const x = 1;\n",
    });
    expect(stdout).toContain("every resolvable target exists");
    expect(exitCode).toBe(0);
  });

  test("fails on a missing target, naming the source line, target and reason", () => {
    const { exitCode, stderr } = runOnFixture({
      "docs/a.md": "# A\n\ntext\n\n[gone](./0011-renamed-away.md)\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("1 broken link(s)");
    expect(stderr).toContain("docs/a.md:5");
    expect(stderr).toContain("link:   ./0011-renamed-away.md");
    expect(stderr).toContain("target: docs/0011-renamed-away.md");
    expect(stderr).toContain("no such file or directory");
  });

  test("covers images and reference definitions, not just inline links", () => {
    const { exitCode, stderr } = runOnFixture({
      "docs/a.md": "# A\n\n![shot](./missing.png)\n\n[ref]: ./missing.md\n\nSee [ref].\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("2 broken link(s)");
    expect(stderr).toContain("docs/missing.png");
    expect(stderr).toContain("docs/missing.md");
  });

  test("does not read untracked Markdown (locally installed skill mirrors etc.)", () => {
    const { exitCode, stdout } = runOnFixture(
      { "README.md": "# R\n" },
      { ".claude/skills/x/SKILL.md": "# X\n\n[broken](./nope.md)\n" },
    );
    expect(stdout).toContain("1 Markdown file(s)");
    expect(exitCode).toBe(0);
  });

  test("fails on a target that exists locally but is not tracked by git", () => {
    const { exitCode, stderr } = runOnFixture(
      { "docs/a.md": "# A\n\n[mirror](../.claude/skills/x/SKILL.md)\n" },
      { ".claude/skills/x/SKILL.md": "# X\n" },
    );
    expect(exitCode).toBe(1);
    expect(stderr).toContain("not tracked by git");
    expect(stderr).toContain("does not exist on GitHub");
  });

  test("fails on a target that resolves outside the repository", () => {
    const { exitCode, stderr } = runOnFixture({ "docs/a.md": "# A\n\n[out](../../etc/hosts)\n" });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("resolves outside the repository");
  });
});

describe("check-doc-links.mjs — absolute links into this repository (#548)", () => {
  // The URL prefix is imported from the same constant the runtime docsUrl()
  // builder uses, so this literal is the one place the test asserts its spelling.
  const BLOB = "https://github.com/ozzy-labs/suasor/blob/main";

  test("resolves a repository blob URL like a relative link", () => {
    const { exitCode, stderr } = runOnFixture({
      "docs/skills/x/SKILL.md": `# X\n\n[here](${BLOB}/docs/adr/0008-a.md)\n[gone](${BLOB}/docs/adr/0011-renamed-away.md)\n`,
      "docs/adr/0008-a.md": "# A\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("1 broken link(s)");
    expect(stderr).toContain("docs/skills/x/SKILL.md:4");
    expect(stderr).toContain("target: docs/adr/0011-renamed-away.md");
  });

  test("checks the fragment of a repository blob URL", () => {
    const { exitCode, stderr } = runOnFixture({
      "docs/skills/x/SKILL.md": `# X\n\n[ok](${BLOB}/docs/adr/0008-a.md#context)\n[bad](${BLOB}/docs/adr/0008-a.md#no-such-anchor)\n`,
      "docs/adr/0008-a.md": "# A\n\n## Context\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("1 broken link(s)");
    expect(stderr).toContain("docs/adr/0008-a.md#no-such-anchor");
  });

  test("leaves URLs that are not this repository's default-branch tree alone", () => {
    const { exitCode } = runOnFixture({
      "docs/a.md": [
        "# A",
        "",
        "[issue](https://github.com/ozzy-labs/suasor/issues/548)",
        "[other repo](https://github.com/ozzy-labs/handbook/blob/main/adr/0028-x.md)",
        "[permalink](https://github.com/ozzy-labs/suasor/blob/deadbeef/docs/gone.md)",
        "[tree](https://github.com/ozzy-labs/suasor/tree/main/docs/gone)",
        "",
      ].join("\n"),
    });
    expect(exitCode).toBe(0);
  });
});

describe("check-doc-links.mjs — shipped roots (#548)", () => {
  /** A manifest that ships `docs/skills` on its own, as the real one does. */
  const manifest = JSON.stringify({ files: ["dist/index.js", "docs/skills"] });

  test("applies to any shipped directory, not only ones under docs/", () => {
    // The rule follows what is distributed, not where it happens to live.
    const { exitCode, stderr } = runOnFixture({
      "package.json": JSON.stringify({ files: ["templates"] }),
      "templates/note.md": "# Note\n\n[adr](../docs/adr/0008-a.md)\n",
      "docs/adr/0008-a.md": "# A\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("templates/ is distributed on its own");
  });

  test("a files entry naming a single file is not a root", () => {
    // `dist/index.js` and friends are files; treating them as roots would flag
    // links they cannot possibly contain.
    const { exitCode } = runOnFixture({
      "package.json": JSON.stringify({ files: ["docs/guide/install.md"] }),
      "docs/guide/install.md": "# Install\n\n[adr](../adr/0008-a.md)\n",
      "docs/adr/0008-a.md": "# A\n",
    });
    expect(exitCode).toBe(0);
  });

  test("fails on a relative link that escapes the shipped root, naming the URL to use", () => {
    const { exitCode, stderr } = runOnFixture({
      "package.json": manifest,
      "docs/skills/x/SKILL.md": "# X\n\n[adr](../../adr/0008-a.md)\n",
      "docs/adr/0008-a.md": "# A\n",
    });
    // The target exists — that is the whole point: check 1 passes and the link
    // is still dead for everyone reading the installed mirror.
    expect(exitCode).toBe(1);
    expect(stderr).toContain("docs/skills/ is distributed on its own");
    expect(stderr).toContain("https://github.com/ozzy-labs/suasor/blob/main/docs/adr/0008-a.md");
  });

  test("allows relative links that stay inside the shipped root", () => {
    // Sibling skills are installed together, so `../other/SKILL.md` resolves in
    // the host dir exactly as it does in the repo.
    const { exitCode } = runOnFixture({
      "package.json": manifest,
      "docs/skills/x/SKILL.md": "# X\n\n[pair](../y/SKILL.md)\n[catalog](../README.md)\n",
      "docs/skills/y/SKILL.md": "# Y\n",
      "docs/skills/README.md": "# Skills\n",
    });
    expect(exitCode).toBe(0);
  });

  test("does not restrict docs that are not shipped on their own", () => {
    const { exitCode } = runOnFixture({
      "package.json": manifest,
      "docs/design/cli.md": "# CLI\n\n[adr](../adr/0008-a.md)\n",
      "docs/adr/0008-a.md": "# A\n",
    });
    expect(exitCode).toBe(0);
  });

  test("reports a globbed shipped root as unverified instead of half-reading it", () => {
    // npm accepts globs in `files`; expanding them here would decide the rule on
    // a guess. Saying so out loud is the only answer that is not a wrong one.
    const { exitCode, stdout } = runOnFixture({
      "package.json": JSON.stringify({ files: ["docs/skills/*"] }),
      "docs/skills/x/SKILL.md": "# X\n\n[adr](../../adr/0008-a.md)\n",
      "docs/adr/0008-a.md": "# A\n",
    });
    expect(stdout).toContain("unverified:");
    expect(stdout).toContain('"docs/skills/*" is a glob');
    expect(exitCode).toBe(0);
  });

  test("the rule keys on package.json rather than a hardcoded path", () => {
    // Same tree, a manifest that ships nothing: the link is then only as fragile
    // as any other relative link, and the checker says so by staying quiet.
    const { exitCode } = runOnFixture({
      "package.json": JSON.stringify({ files: ["dist/index.js"] }),
      "docs/skills/x/SKILL.md": "# X\n\n[adr](../../adr/0008-a.md)\n",
      "docs/adr/0008-a.md": "# A\n",
    });
    expect(exitCode).toBe(0);
  });
});

describe("check-doc-links.mjs — cross-file fragments", () => {
  test("accepts a fragment that matches a heading in the target file", () => {
    const { exitCode } = runOnFixture({
      "docs/a.md": "# A\n\n[x](./b.md#長文ドキュメントの扱いretrieval-m1)\n",
      "docs/b.md": "# B\n\n## 長文ドキュメントの扱い（retrieval M1）\n",
    });
    expect(exitCode).toBe(0);
  });

  test("fails when the heading was renamed out from under the fragment", () => {
    const { exitCode, stderr } = runOnFixture({
      "docs/a.md": "# A\n\n[x](./b.md#old-heading)\n",
      "docs/b.md": "# B\n\n## New Heading\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("target: docs/b.md#old-heading");
    expect(stderr).toContain('no heading or anchor whose slug is "old-heading"');
  });

  test("reports a fragment on a non-Markdown target as unverified, not as a pass", () => {
    const { exitCode, stdout } = runOnFixture({
      "docs/a.md": "# A\n\n[line](../src/x.ts#L10)\n",
      "src/x.ts": "export const x = 1;\n",
    });
    expect(stdout).toContain("unverified:");
    expect(stdout).toContain('fragment "#L10"');
    expect(exitCode).toBe(0);
  });

  test("refuses to report a pass when the MD051 control probe is not rejected", () => {
    // The target ends inside an unterminated fence, which swallows the probes.
    const { exitCode, stderr } = runOnFixture({
      "docs/a.md": "# A\n\n[x](./b.md#anything)\n",
      "docs/b.md": "# B\n\n```text\nnever closed\n",
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("fragment check is not working");
    expect(stderr).toContain("Refusing to report a pass");
  });
});

describe("check-doc-links.mjs — docsUrl() call sites", () => {
  test("fails when a docsUrl() literal points at a doc that does not exist", () => {
    const { exitCode, stderr } = runOnFixture({
      "docs/guide/kept.md": "# Kept\n",
      "src/cli/hint.ts":
        'const a = docsUrl("guide/kept.md");\nconst b = docsUrl("guide/gone.md");\n',
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("1 broken link(s)");
    expect(stderr).toContain("src/cli/hint.ts:2");
    expect(stderr).toContain("target: docs/guide/gone.md");
  });

  test("checks the fragment of a docsUrl() literal too", () => {
    const { exitCode, stderr } = runOnFixture({
      "docs/guide/install.md": "# Install\n\n## Binary scope\n",
      "src/cli/a.ts": 'docsUrl("guide/install.md#binary-scope");\n',
      "src/cli/b.ts": 'docsUrl("guide/install.md#no-such-anchor");\n',
    });
    expect(exitCode).toBe(1);
    expect(stderr).toContain("1 broken link(s)");
    expect(stderr).toContain("src/cli/b.ts");
    expect(stderr).toContain("docs/guide/install.md#no-such-anchor");
  });

  test("reports a non-literal argument as unverified rather than guessing", () => {
    const { exitCode, stdout } = runOnFixture({
      "src/cli/a.ts": "const page = pick();\nconst url = docsUrl(page);\n",
    });
    expect(stdout).toContain("unverified:");
    expect(stdout).toContain("not a string literal");
    expect(exitCode).toBe(0);
  });

  test("does not mistake the docsUrl() declaration for a call site", () => {
    const { exitCode, stdout } = runOnFixture({
      "src/shared/doc-ref.ts":
        "export function docsUrl(path: string): string {\n  return path;\n}\n",
    });
    expect(stdout).not.toContain("unverified:");
    expect(exitCode).toBe(0);
  });
});
