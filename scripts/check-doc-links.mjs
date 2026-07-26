#!/usr/bin/env node
/**
 * Relative-link existence check for the repository's Markdown (#543).
 *
 * The gap this closes: markdownlint validates link *syntax*, never the target.
 * `MD051/link-fragments` is the one exception — it checks `#fragment` links
 * against the headings of the **same** file. So renaming an ADR, or citing one
 * under a name it never had, passes `bun run lint:md` and dies silently in the
 * rendered docs. Six such links were already on main the first time this script
 * ran. A dead pointer is a wrong answer the reader cannot detect, which is
 * exactly what ADR-0007's "no silent wrong answer" rules out.
 *
 * What is checked
 *   1. every relative link / image / reference definition in tracked Markdown,
 *      including directory targets and non-Markdown targets (e.g. a `src/**`
 *      file quoted from a design doc). The target must be **tracked by git** and
 *      inside the repository: a link that resolves only in the author's checkout
 *      (a build artefact, an installed skill mirror, `../` out of the tree) opens
 *      locally and 404s for everyone reading the docs on GitHub, which is the
 *      same silent failure wearing a different hat;
 *   2. the `#fragment` of a link that points at *another* Markdown file
 *      (same-file fragments are already MD051's job — see below);
 *   3. the literal argument of every `docsUrl("...")` call under `src/`.
 *      `docsUrl()` (src/shared/doc-ref.ts) turns a repo doc path into a GitHub
 *      blob URL that the CLI / config / MCP layers print to users. It is a
 *      different *mechanism* from a Markdown link but the identical *failure*:
 *      rename the doc and the CLI keeps printing a 404, with nobody the wiser.
 *      Every argument today is a string literal, so it costs nothing to resolve
 *      statically. A call site whose argument is not a literal cannot be
 *      resolved this way; it is listed as `unverified` rather than guessed at or
 *      silently skipped, and does not fail the run. `tests/` is excluded on
 *      purpose — a test may legitimately pass a synthetic path to exercise the
 *      URL builder, and failing on that would be a wrong verdict.
 *
 * What is NOT checked, and why
 *   - Absolute URLs (`https://…`, `mailto:`): verifying them needs the network,
 *     which would make the lint job non-hermetic and flaky.
 *   - Same-file `#fragment` links: already enforced by MD051 in
 *     `bun run lint:md`. Re-implementing GitHub's heading slugger here would put
 *     a second, drifting answer next to a question that is already answered.
 *   - Fragments on non-Markdown targets (`foo.ts#L10` and the like): GitHub's
 *     line anchors are not derivable from file content. There are none in the
 *     repo today; if one appears, the *file* half is still checked and the
 *     fragment half is reported as `unverified`, not passed.
 *   - Raw HTML links (`<a href>`, `<img src>`): `MD033/no-inline-html` limits
 *     inline HTML to `details` / `summary` / `description`, so a raw HTML link
 *     cannot get past lint in the first place.
 *   - `CHANGELOG.md`: release-please-generated and never hand-edited (the same
 *     reason `.markdownlint-cli2.yaml` ignores it). Untracked files are never
 *     *scanned* either — the file list comes from `git ls-files`, which is what
 *     keeps the locally installed skill mirrors (`.claude/skills`,
 *     `.agents/skills`; ADR-0035) from being linted here. Note the asymmetry:
 *     untracked files are not scanned, but they are not valid *targets* either.
 *
 * How fragments are checked without a second slugger: the target file's content
 * is linted by markdownlint with `MD051` enabled and probe links
 * (`[probe](#fragment)`) appended, so the verdict comes from the very rule
 * implementation that already validates same-file fragments. A deliberately
 * invalid control probe goes in alongside; if MD051 does *not* reject the
 * control, the probes did not land where the rule looks (an unterminated code
 * fence at end of file will do that) and the script fails loudly instead of
 * reporting a pass it never actually made.
 *
 * Usage: `bun run lint:links` (CI `lint` job + lefthook pre-commit).
 * Exit code: 0 when every resolvable target exists, 1 otherwise.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

let lint;
try {
  ({ lint } = await import("markdownlint/sync"));
} catch {
  console.error(
    "check-doc-links: cannot load `markdownlint` — run `bun install` before linting.",
  );
  process.exit(1);
}

/** Tracked Markdown that is deliberately not checked (see the header comment). */
const IGNORED_MARKDOWN = new Set(["CHANGELOG.md"]);

/** Fragment probe that must never match a real heading (harness self-check). */
const CONTROL_FRAGMENT = "suasor-doc-links-control-fragment-never-a-heading";

/** List repo-relative tracked files matching the given pathspecs. */
function listTrackedFiles(root, pathspecs) {
  const out = execFileSync("git", ["ls-files", "-z", "--", ...pathspecs], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split("\0").filter((path) => path.length > 0);
}

/**
 * The set of paths a link may legitimately point at: every tracked file, plus
 * every directory that holds one. Tracked-ness rather than on-disk existence is
 * the right test — a link to a build artefact or to an installed skill mirror
 * (`.claude/skills/…`, ADR-0035) opens fine in the author's checkout and 404s
 * for everyone reading the docs on GitHub.
 */
function trackedTargets(root) {
  const files = new Set(listTrackedFiles(root, []));
  const directories = new Set(["."]);
  for (const file of files) {
    const segments = file.split("/");
    for (let i = 1; i < segments.length; i += 1) directories.add(segments.slice(0, i).join("/"));
  }
  return { files, directories };
}

/** Undo Markdown backslash escapes and percent-encoding in a destination. */
function decodeDestination(value) {
  const unescaped = value.replace(/\\([!-/:-@[-`{-~])/g, "$1");
  try {
    return decodeURIComponent(unescaped);
  } catch {
    return unescaped; // malformed %-sequence: use it verbatim rather than guess
  }
}

/**
 * Split a link destination into its path and fragment halves, or `null` for the
 * destinations this script does not own: absolute URLs, protocol-relative URLs,
 * and fragment-only links (MD051's job).
 */
function splitDestination(destination) {
  const raw = destination.trim();
  if (raw.length === 0) return null;
  if (raw.startsWith("#")) return null; // same-file fragment → MD051
  if (raw.startsWith("//")) return null; // protocol-relative → external
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // https:, mailto:, …
  const hash = raw.indexOf("#");
  const path = decodeDestination(hash === -1 ? raw : raw.slice(0, hash));
  const fragment = hash === -1 ? "" : decodeDestination(raw.slice(hash + 1));
  if (path.length === 0) return null;
  return { path, fragment };
}

/**
 * Collect every link destination in `files` using markdownlint's own Markdown
 * parser, so destinations inside code fences / inline code / HTML comments are
 * excluded exactly as the linter sees them (no regex approximation).
 */
function collectDestinations(root, files) {
  const found = [];
  const collector = {
    names: ["suasor-collect-destinations"],
    description: "Collect link destinations",
    tags: ["links"],
    parser: "micromark",
    function: (params) => {
      const walk = (tokens) => {
        for (const token of tokens) {
          if (
            token.type === "resourceDestinationString" ||
            token.type === "definitionDestinationString"
          ) {
            found.push({
              file: params.name,
              line: token.startLine,
              column: token.startColumn,
              destination: token.text,
            });
          }
          if (token.children?.length > 0) walk(token.children);
        }
      };
      walk(params.parsers.micromark.tokens);
    },
  };
  const strings = {};
  for (const file of files) strings[file] = readFileSync(join(root, file), "utf8");
  lint({
    strings,
    customRules: [collector],
    config: { default: false, "suasor-collect-destinations": true },
  });
  return found;
}

/**
 * Which of `fragments` are invalid in the Markdown file at `absPath`, per MD051.
 *
 * @throws when the control probe is not rejected, i.e. the probes did not land
 *   in a position the rule inspects — an answer that must not be trusted.
 */
function invalidFragments(absPath, fragments) {
  const lines = readFileSync(absPath, "utf8").split("\n");
  const probedFragmentByLine = new Map();
  for (const fragment of [...fragments, CONTROL_FRAGMENT]) {
    lines.push("", `[probe](#${fragment})`);
    probedFragmentByLine.set(lines.length, fragment);
  }
  const results = lint({
    strings: { probe: lines.join("\n") },
    config: { default: false, MD051: true },
  });
  const flagged = new Set();
  for (const error of results.probe ?? []) {
    const fragment = probedFragmentByLine.get(error.lineNumber);
    if (fragment !== undefined) flagged.add(fragment);
  }
  if (!flagged.has(CONTROL_FRAGMENT)) {
    throw new Error(
      `fragment check is not working on ${absPath}: MD051 did not reject the ` +
        "control probe (an unterminated code fence at end of file causes this). " +
        "Refusing to report a pass that was never verified.",
    );
  }
  flagged.delete(CONTROL_FRAGMENT);
  return flagged;
}

/**
 * Locate every `docsUrl(...)` call in `files` and resolve its literal argument.
 * A call whose argument is not a single string literal (no interpolation) gets
 * `path: null` — not resolvable statically, and reported as such.
 */
function collectDocsUrlCalls(root, files) {
  const calls = [];
  const literalArgument =
    /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`$\\]*)`)\s*,?\s*\)/;
  for (const file of files) {
    const text = readFileSync(join(root, file), "utf8");
    for (const match of text.matchAll(/\bdocsUrl\(/g)) {
      const before = text.slice(0, match.index);
      if (/\bfunction\s+$/.test(before)) continue; // the declaration, not a call
      const literal = literalArgument.exec(text.slice(match.index + match[0].length));
      const value = literal ? (literal[1] ?? literal[2] ?? literal[3]) : null;
      calls.push({
        file,
        line: before.split("\n").length,
        path: value === null ? null : value.replace(/^\/+/, ""),
      });
    }
  }
  return calls;
}

/** Format one failure: where it is, what it points at, and what is missing. */
function formatFailure(failure) {
  const at = failure.column > 0 ? `${failure.line}:${failure.column}` : `${failure.line}`;
  return [
    `${failure.file}:${at}`,
    `  link:   ${failure.link}`,
    `  target: ${failure.target}`,
    `  reason: ${failure.reason}`,
  ].join("\n");
}

function main(root) {
  const markdown = listTrackedFiles(root, ["*.md"]).filter((file) => !IGNORED_MARKDOWN.has(file));
  const tracked = trackedTargets(root);
  const failures = [];
  const unverified = [];

  /** Why `shown` is not a valid link target, or `null` when it is one. */
  const rejectTarget = (shown, absolute) => {
    if (shown === ".." || shown.startsWith(`..${sep}`)) {
      return (
        "resolves outside the repository, so it cannot render on GitHub " +
        "(it may still open in a local checkout, which is what hides it)"
      );
    }
    const path = shown.split(sep).join("/");
    if (tracked.files.has(path) || tracked.directories.has(path)) return null;
    return existsSync(absolute)
      ? "present in the working tree but not tracked by git, so it does not exist on GitHub"
      : "no such file or directory in the repository";
  };

  // 1. Markdown link targets, collecting the fragments of the ones that resolve.
  const linksByTargetFile = new Map();
  for (const link of collectDestinations(root, markdown)) {
    const split = splitDestination(link.destination);
    if (split === null) continue;
    const absolute = split.path.startsWith("/")
      ? join(root, split.path.slice(1))
      : resolve(root, dirname(link.file), split.path);
    const shown = relative(root, absolute) || ".";
    const rejected = rejectTarget(shown, absolute);
    if (rejected !== null) {
      failures.push({ ...link, link: link.destination, target: shown, reason: rejected });
      continue;
    }
    if (split.fragment.length === 0) continue;
    if (!absolute.endsWith(".md")) {
      unverified.push(
        `${link.file}:${link.line} — fragment "#${split.fragment}" on the non-Markdown ` +
          `target ${shown} is not derivable from file content (the file itself exists)`,
      );
      continue;
    }
    const entry = linksByTargetFile.get(absolute) ?? [];
    entry.push({ ...link, fragment: split.fragment, shown });
    linksByTargetFile.set(absolute, entry);
  }

  // 2. Cross-file fragments, one MD051 pass per target file.
  for (const [absolute, links] of [...linksByTargetFile].sort()) {
    const invalid = invalidFragments(absolute, [...new Set(links.map((l) => l.fragment))]);
    for (const link of links) {
      if (!invalid.has(link.fragment)) continue;
      failures.push({
        ...link,
        link: link.destination,
        target: `${link.shown}#${link.fragment}`,
        reason:
          `${link.shown} exists but has no heading or anchor whose slug is ` +
          `"${link.fragment}" (checked with markdownlint MD051, the same rule ` +
          "that validates same-file fragments)",
      });
    }
  }

  // 3. docsUrl() literals — the same failure mode, spelled in TypeScript.
  const docsUrlCalls = collectDocsUrlCalls(root, listTrackedFiles(root, ["src/*.ts"]));
  for (const call of docsUrlCalls) {
    if (call.path === null) {
      unverified.push(
        `${call.file}:${call.line} — docsUrl() argument is not a string literal, ` +
          "so its target cannot be resolved statically",
      );
      continue;
    }
    const hash = call.path.indexOf("#");
    const docPath = hash === -1 ? call.path : call.path.slice(0, hash);
    const fragment = hash === -1 ? "" : call.path.slice(hash + 1);
    const absolute = join(root, "docs", docPath);
    const shown = join("docs", docPath);
    const failure = {
      file: call.file,
      line: call.line,
      column: 0,
      link: `docsUrl("${call.path}")`,
    };
    const rejected = rejectTarget(shown, absolute);
    if (rejected !== null) {
      failures.push({
        ...failure,
        target: shown,
        reason: `${rejected} (docsUrl() paths are relative to the repository's docs/ directory)`,
      });
      continue;
    }
    if (fragment.length === 0 || !absolute.endsWith(".md")) continue;
    if (invalidFragments(absolute, [fragment]).has(fragment)) {
      failures.push({
        ...failure,
        target: `${shown}#${fragment}`,
        reason:
          `${shown} exists but has no heading or anchor whose slug is "${fragment}" ` +
          "(checked with markdownlint MD051)",
      });
    }
  }

  for (const note of [...unverified].sort()) console.log(`unverified: ${note}`);
  if (failures.length === 0) {
    console.log(
      `✔ check-doc-links: ${markdown.length} Markdown file(s) + ${docsUrlCalls.length} ` +
        "docsUrl() call site(s), every resolvable target exists",
    );
    return 0;
  }
  failures.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  console.error(`\n✖ check-doc-links: ${failures.length} broken link(s)\n`);
  for (const failure of failures) console.error(`${formatFailure(failure)}\n`);
  console.error(
    "Fix the link, or the rename that orphaned it. Absolute URLs and same-file\n" +
      "#fragments are out of scope here — see the header of scripts/check-doc-links.mjs.",
  );
  return 1;
}

try {
  process.exitCode = main(process.cwd());
} catch (error) {
  console.error(`✖ check-doc-links: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
