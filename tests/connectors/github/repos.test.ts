/**
 * GitHub repository discovery leaf (`github repos`, ADR-0030). Exercises the
 * `fetch`-free path with an injected transport: enumeration, Link-header
 * pagination, visibility derivation, `--filter`, and the paste-ready config
 * block. No network, no SDK.
 */
import { describe, expect, test } from "bun:test";
import {
  type GithubReposTransport,
  listRepos,
  parseNextLink,
  renderConfigBlock,
} from "../../../src/connectors/github/repos.ts";

/** Build a transport that serves one or more pages keyed by url, recording calls. */
function fakeTransport(pages: { body: unknown; linkHeader?: string | null; status?: number }[]): {
  transport: GithubReposTransport;
  urls: string[];
} {
  const urls: string[] = [];
  let i = 0;
  const transport: GithubReposTransport = async ({ url }) => {
    urls.push(url);
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return {
      status: page?.status ?? 200,
      linkHeader: page?.linkHeader ?? null,
      body: page?.body ?? [],
    };
  };
  return { transport, urls };
}

describe("repos — listRepos", () => {
  test("enumerates repos, derives visibility, sorts a-z by full name", async () => {
    const { transport } = fakeTransport([
      {
        body: [
          { full_name: "octocat/zeta", visibility: "public" },
          { full_name: "octocat/alpha", private: true },
          { full_name: "acme/widget", visibility: "private", archived: true },
        ],
      },
    ]);
    const { repos } = await listRepos("ghp_x", { transport });
    expect(repos.map((r) => r.fullName)).toEqual(["acme/widget", "octocat/alpha", "octocat/zeta"]);
    const byName = Object.fromEntries(repos.map((r) => [r.fullName, r]));
    expect(byName["octocat/zeta"]?.visibility).toBe("public");
    expect(byName["octocat/alpha"]?.visibility).toBe("private"); // from `private: true`
    expect(byName["acme/widget"]?.visibility).toBe("private");
    expect(byName["acme/widget"]?.isArchived).toBe(true);
  });

  test("follows Link rel=next across pages and requests per_page=100", async () => {
    const { transport, urls } = fakeTransport([
      {
        body: [{ full_name: "o/a" }],
        linkHeader: '<https://api.github.com/user/repos?page=2>; rel="next"',
      },
      { body: [{ full_name: "o/b" }], linkHeader: null },
    ]);
    const { repos } = await listRepos("ghp_x", { transport });
    expect(repos.map((r) => r.fullName)).toEqual(["o/a", "o/b"]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("per_page=100");
    expect(urls[1]).toBe("https://api.github.com/user/repos?page=2");
  });

  test("--filter narrows by case-insensitive substring of full_name", async () => {
    const { transport } = fakeTransport([
      {
        body: [
          { full_name: "acme/widget" },
          { full_name: "acme/gadget" },
          { full_name: "octocat/spoon" },
        ],
      },
    ]);
    const { repos } = await listRepos("ghp_x", { transport, filter: "ACME" });
    expect(repos.map((r) => r.fullName)).toEqual(["acme/gadget", "acme/widget"]);
  });

  test("honours a custom baseUrl (GitHub Enterprise)", async () => {
    const { transport, urls } = fakeTransport([{ body: [{ full_name: "o/a" }] }]);
    await listRepos("ghp_x", { transport, baseUrl: "https://ghe.example.com/api/v3/" });
    expect(urls[0]?.startsWith("https://ghe.example.com/api/v3/user/repos")).toBe(true);
  });

  test("throws with status + message (never the token) on a non-2xx", async () => {
    const { transport } = fakeTransport([{ status: 401, body: { message: "Bad credentials" } }]);
    await expect(listRepos("ghp_secret", { transport })).rejects.toThrow(
      /github GET \/user\/repos failed: 401 Bad credentials/,
    );
    await expect(listRepos("ghp_secret", { transport })).rejects.not.toThrow(/ghp_secret/);
  });

  test("skips rows without a full_name and tolerates a non-array body", async () => {
    const { transport } = fakeTransport([
      { body: [{ visibility: "public" }, { full_name: "o/a" }] },
    ]);
    const a = await listRepos("ghp_x", { transport });
    expect(a.repos.map((r) => r.fullName)).toEqual(["o/a"]);
    const { transport: t2 } = fakeTransport([{ body: { message: "not an array" } }]);
    const b = await listRepos("ghp_x", { transport: t2 });
    expect(b.repos).toEqual([]);
  });

  test("onProgress ticks per page and a throwing reporter does not fail the sweep", async () => {
    const { transport } = fakeTransport([
      {
        body: [{ full_name: "o/a" }],
        linkHeader: '<https://api.github.com/user/repos?page=2>; rel="next"',
      },
      { body: [{ full_name: "o/b" }] },
    ]);
    let ticks = 0;
    const { repos } = await listRepos("ghp_x", {
      transport,
      onProgress: () => {
        ticks += 1;
        throw new Error("boom");
      },
    });
    expect(ticks).toBe(2);
    expect(repos).toHaveLength(2);
  });
});

describe("repos — parseNextLink", () => {
  test("extracts rel=next from a multi-rel Link header", () => {
    const header =
      '<https://api.github.com/user/repos?page=1>; rel="prev", ' +
      '<https://api.github.com/user/repos?page=3>; rel="next", ' +
      '<https://api.github.com/user/repos?page=9>; rel="last"';
    expect(parseNextLink(header)).toBe("https://api.github.com/user/repos?page=3");
  });

  test("returns null when there is no next page or no header", () => {
    expect(parseNextLink(null)).toBeNull();
    expect(parseNextLink('<https://x/page=9>; rel="last"')).toBeNull();
  });
});

describe("repos — renderConfigBlock", () => {
  test("renders a paste-ready [connectors.github] block with visibility labels", () => {
    const lines = renderConfigBlock({
      repos: [
        { fullName: "octocat/alpha", visibility: "public", isArchived: false },
        { fullName: "acme/widget", visibility: "private", isArchived: true },
      ],
    });
    const text = lines.join("\n");
    expect(lines[0]).toBe("[connectors.github]");
    expect(text).toContain("enabled = true");
    expect(text).toContain("repos = [");
    expect(text).toContain('"octocat/alpha",  # public');
    expect(text).toContain('"acme/widget",  # private, archived');
    expect(text).toContain("# repos are 'owner/repo' full names");
  });

  test("renders an empty repos array when nothing is discovered", () => {
    const lines = renderConfigBlock({ repos: [] });
    expect(lines).toContain("repos = []");
    expect(lines.join("\n")).not.toContain("repos = [\n");
  });
});
