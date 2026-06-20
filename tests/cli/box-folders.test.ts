/**
 * `suasor box folders` discovery CLI wiring + the DISCOVERY_SPECS probe
 * (ADR-0030). No network: the no-credential path short-circuits before any probe;
 * the box probe is exercised directly with an injected secret resolver + a fake
 * transport via the spec's lazy leaf import.
 */
import { describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index.ts";
import {
  type BoxFoldersTransport,
  listFolders,
  renderConfigBlock,
  renderTree,
} from "../../src/connectors/box/folders.ts";
import { DISCOVERY_SPECS, discoveryConnectorNames } from "../../src/connectors/discovery-specs.ts";

const SECRET_ENVS = ["SUASOR_CONNECTOR_BOX_TOKEN"];

/** Run the CLI capturing stdout/stderr (box secret env cleared). */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const saved = SECRET_ENVS.map((k) => [k, process.env[k]] as const);
  for (const k of SECRET_ENVS) delete process.env[k];
  let out = "";
  let err = "";
  const cli = buildCli();
  try {
    const code = await cli.run(args, {
      stdin: (async function* () {})() as unknown as NodeJS.ReadStream,
      stdout: {
        write: (s: string) => {
          out += s;
          return true;
        },
      } as NodeJS.WriteStream,
      stderr: {
        write: (s: string) => {
          err += s;
          return true;
        },
      } as NodeJS.WriteStream,
      env: process.env,
      colorDepth: 1,
    });
    return { code, out, err };
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * A fake Box folder tree, keyed by folder id → its direct subfolder entries
 * (mirroring `GET /2.0/folders/<id>/items`, folders only). The transport pages
 * once (no marker) for simplicity unless a page is split by the test.
 */
function treeTransport(tree: Record<string, { id: string; name: string }[]>): BoxFoldersTransport {
  return async ({ folderId }) => ({
    status: 200,
    body: {
      entries: (tree[folderId] ?? []).map((f) => ({ type: "folder", id: f.id, name: f.name })),
    },
  });
}

describe("DISCOVERY_SPECS table (SSOT)", () => {
  test("exposes box folders alongside github + google", () => {
    expect(discoveryConnectorNames()).toEqual(["box", "github", "google"]);
    expect(DISCOVERY_SPECS.box?.verb).toBe("folders");
    expect(DISCOVERY_SPECS.box?.acceptsRoot).toBe(true);
  });
});

describe("suasor box folders — CLI wiring (no network)", () => {
  test("registers `box folders` in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("box folders");
  });

  test("box folders without a token exits 1 with onboarding guidance", async () => {
    const { code, err } = await run(["box", "folders"]);
    expect(code).toBe(1);
    expect(err).toContain("no box token configured");
    expect(err).toContain("box auth set");
  });

  test("--root is accepted by box folders (still fails without a token)", async () => {
    const { code, err } = await run(["box", "folders", "--root", "999"]);
    // --root is a valid option for box; the failure is the missing token, not an
    // unknown-option / does-not-accept-root error.
    expect(code).toBe(1);
    expect(err).toContain("no box token configured");
    expect(err).not.toContain("does not accept --root");
  });
});

describe("DISCOVERY_SPECS.box.discover probe (injected secret + transport)", () => {
  test("throws the no-token error when the secret is absent", async () => {
    await expect(
      DISCOVERY_SPECS.box?.discover({ secret: async () => null, config: {} }),
    ).rejects.toThrow(/no box token configured/);
  });
});

describe("box folders leaf — listFolders / renderTree / renderConfigBlock", () => {
  test("enumerates a single level under the default root, sorted a-z", async () => {
    const transport = treeTransport({
      "0": [
        { id: "30", name: "Zeta" },
        { id: "10", name: "Alpha" },
        { id: "20", name: "Mid" },
      ],
    });
    const result = await listFolders("tok", { transport });
    expect(result.root).toBe("0");
    expect(result.folders.map((f) => f.name)).toEqual(["Alpha", "Mid", "Zeta"]);
    expect(result.folders.every((f) => f.depth === 0)).toBe(true);
    expect(result.folders.every((f) => f.parentId === "0")).toBe(true);
  });

  test("recurses to maxDepth in pre-order (parent before its children)", async () => {
    const transport = treeTransport({
      "0": [{ id: "10", name: "Alpha" }],
      "10": [{ id: "11", name: "Alpha-Child" }],
      "11": [{ id: "12", name: "Too-Deep" }],
    });
    const result = await listFolders("tok", { transport, maxDepth: 1 });
    expect(result.folders.map((f) => `${f.depth}:${f.name}`)).toEqual(["0:Alpha", "1:Alpha-Child"]);
    // maxDepth=1 stops before the third level.
    expect(result.folders.find((f) => f.name === "Too-Deep")).toBeUndefined();
  });

  test("--root walks from the given folder id", async () => {
    const transport = treeTransport({
      "777": [{ id: "778", name: "Under777" }],
    });
    const result = await listFolders("tok", { transport, root: "777" });
    expect(result.root).toBe("777");
    expect(result.folders.map((f) => f.id)).toEqual(["778"]);
  });

  test("filter narrows by name or id (case-insensitive)", async () => {
    const transport = treeTransport({
      "0": [
        { id: "10", name: "Reports" },
        { id: "20", name: "Invoices" },
      ],
    });
    const result = await listFolders("tok", { transport, filter: "report" });
    expect(result.folders.map((f) => f.name)).toEqual(["Reports"]);
  });

  test("pages a folder via the marker", async () => {
    let calls = 0;
    const transport: BoxFoldersTransport = async ({ marker }) => {
      calls += 1;
      if (!marker) {
        return {
          status: 200,
          body: {
            entries: [{ type: "folder", id: "10", name: "Page1" }],
            next_marker: "m2",
          },
        };
      }
      return {
        status: 200,
        body: { entries: [{ type: "folder", id: "20", name: "Page2" }] },
      };
    };
    const result = await listFolders("tok", { transport });
    expect(calls).toBe(2);
    expect(result.folders.map((f) => f.id).sort()).toEqual(["10", "20"]);
  });

  test("ignores non-folder entries (files)", async () => {
    const transport: BoxFoldersTransport = async () => ({
      status: 200,
      body: {
        entries: [
          { type: "file", id: "f1", name: "doc.pdf" },
          { type: "folder", id: "10", name: "Keep" },
        ],
      },
    });
    const result = await listFolders("tok", { transport });
    expect(result.folders.map((f) => f.id)).toEqual(["10"]);
  });

  test("throws with the HTTP status on a non-2xx (token never echoed)", async () => {
    const transport: BoxFoldersTransport = async () => ({
      status: 404,
      body: { message: "Not Found" },
    });
    await expect(listFolders("secret-token", { transport, root: "404" })).rejects.toThrow(
      /box GET \/2\.0\/folders\/404\/items failed: 404 Not Found/,
    );
    await expect(listFolders("secret-token", { transport, root: "404" })).rejects.not.toThrow(
      /secret-token/,
    );
  });

  test("renderTree indents by depth and shows id + name", async () => {
    const result: Awaited<ReturnType<typeof listFolders>> = {
      root: "0",
      folders: [
        { id: "10", name: "Alpha", depth: 0, parentId: "0" },
        { id: "11", name: "Child", depth: 1, parentId: "10" },
      ],
    };
    expect(renderTree(result)).toEqual(["10  Alpha", "  11  Child"]);
  });

  test("renderTree reports an empty namespace", async () => {
    expect(renderTree({ root: "777", folders: [] })).toEqual(['(no subfolders under "777")']);
  });

  test("renderConfigBlock emits a paste-ready [connectors.box] folders array", async () => {
    const result: Awaited<ReturnType<typeof listFolders>> = {
      root: "0",
      folders: [
        { id: "10", name: "Alpha", depth: 0, parentId: "0" },
        { id: "11", name: "Child", depth: 1, parentId: "10" },
      ],
    };
    const block = renderConfigBlock(result).join("\n");
    expect(block).toContain("[connectors.box]");
    expect(block).toContain("enabled = true");
    expect(block).toContain('"10",  # Alpha');
    expect(block).toContain('"11",  # Child');
  });

  test("renderConfigBlock emits an empty array when nothing is discovered", async () => {
    const block = renderConfigBlock({ root: "0", folders: [] }).join("\n");
    expect(block).toContain("folders = []");
  });

  test("the spec probe normalizes items + tree listing + config block", async () => {
    const transport = treeTransport({
      "0": [{ id: "10", name: "Alpha" }],
      "10": [{ id: "11", name: "Child" }],
    });
    // Exercise the leaf the spec delegates to (the spec lazy-imports it); confirm
    // the renderers the CLI prints.
    const result = await listFolders("tok", { transport, maxDepth: 1 });
    expect(renderTree(result)).toEqual(["10  Alpha", "  11  Child"]);
    expect(renderConfigBlock(result).join("\n")).toContain('"10",  # Alpha');
  });
});
