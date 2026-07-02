/**
 * `docsUrl` — repo-relative doc path → followable GitHub blob URL (Issue #386).
 * Pure string helper: the CLI prints doc pointers that must resolve from every
 * install channel (npm / binary / Docker), not just a source checkout.
 */
import { describe, expect, test } from "bun:test";
import { DOCS_BASE_URL, docsUrl } from "../../src/cli/doc-ref.ts";

describe("docsUrl", () => {
  test("resolves a guide path to an absolute GitHub blob URL on main", () => {
    expect(docsUrl("guide/connectors.md")).toBe(
      "https://github.com/ozzy-labs/suasor/blob/main/docs/guide/connectors.md",
    );
  });

  test("preserves an #anchor fragment", () => {
    expect(docsUrl("guide/install.md#binary-scope")).toBe(
      "https://github.com/ozzy-labs/suasor/blob/main/docs/guide/install.md#binary-scope",
    );
  });

  test("output always contains the repo-relative docs path (substring back-compat)", () => {
    // Existing call sites / tests match on the bare `docs/guide/*.md` substring;
    // expanding to a URL must keep that substring so pointers stay greppable.
    expect(docsUrl("guide/scheduling.md")).toContain("docs/guide/scheduling.md");
  });

  test("tolerates a leading slash without doubling it", () => {
    expect(docsUrl("/guide/embedding.md")).toBe(`${DOCS_BASE_URL}/guide/embedding.md`);
  });

  test("DOCS_BASE_URL points at the repository docs root on the default branch", () => {
    expect(DOCS_BASE_URL).toBe("https://github.com/ozzy-labs/suasor/blob/main/docs");
  });
});
