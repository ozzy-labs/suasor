/**
 * `suasor notion databases` discovery CLI wiring + the DISCOVERY_SPECS probe
 * (ADR-0030). No network: the no-credential path short-circuits before any probe;
 * the notion probe is exercised directly with an injected secret resolver + a fake
 * transport via the leaf module.
 */
import { describe, expect, test } from "bun:test";
import { buildCli } from "../../src/cli/index.ts";
import { DISCOVERY_SPECS } from "../../src/connectors/discovery-specs.ts";
import {
  listDatabases,
  type NotionDatabasesTransport,
  renderConfigBlock,
} from "../../src/connectors/notion/databases.ts";

const SECRET_ENVS = ["SUASOR_CONNECTOR_NOTION_TOKEN"];

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

/** A fake `search` transport keyed by start_cursor for pagination. */
function searchTransport(
  pages: { databases: { id: string; title: string }[]; nextCursor?: string }[],
): NotionDatabasesTransport {
  let idx = 0;
  return async () => {
    const page = pages[idx] ?? { databases: [] };
    idx += 1;
    return {
      status: 200,
      body: {
        results: page.databases.map((d) => ({
          object: "database",
          id: d.id,
          title: [{ plain_text: d.title }],
        })),
        has_more: page.nextCursor !== undefined,
        next_cursor: page.nextCursor,
      },
    };
  };
}

describe("suasor notion databases — CLI wiring (no network)", () => {
  test("registers `notion databases` in --help", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("notion databases");
  });

  test("notion databases without a token exits 1 with onboarding guidance", async () => {
    const { code, err } = await run(["notion", "databases"]);
    expect(code).toBe(1);
    expect(err).toContain("no notion token configured");
    expect(err).toContain("notion auth set");
  });

  test("--root is rejected (notion databases is a flat namespace)", async () => {
    const { code, err } = await run(["notion", "databases", "--root", "x"]);
    expect(code).toBe(1);
    expect(err).toContain("does not accept --root");
  });
});

describe("DISCOVERY_SPECS.notion.discover probe (injected secret)", () => {
  test("throws the no-token error when the secret is absent", async () => {
    await expect(
      DISCOVERY_SPECS.notion?.discover({ secret: async () => null, config: {} }),
    ).rejects.toThrow(/no notion token configured/);
  });
});

describe("notion databases leaf — listDatabases / renderConfigBlock", () => {
  test("enumerates databases sorted a-z by title", async () => {
    const transport = searchTransport([
      {
        databases: [
          { id: "30", title: "Zeta" },
          { id: "10", title: "Alpha" },
          { id: "20", title: "Mid" },
        ],
      },
    ]);
    const result = await listDatabases("tok", { transport });
    expect(result.databases.map((d) => d.title)).toEqual(["Alpha", "Mid", "Zeta"]);
  });

  test("paginates via next_cursor", async () => {
    const transport = searchTransport([
      { databases: [{ id: "1", title: "A" }], nextCursor: "c2" },
      { databases: [{ id: "2", title: "B" }] },
    ]);
    const result = await listDatabases("tok", { transport });
    expect(result.databases.map((d) => d.id).sort()).toEqual(["1", "2"]);
  });

  test("filters by title or id (case-insensitive)", async () => {
    const transport = searchTransport([
      {
        databases: [
          { id: "10", title: "Reports" },
          { id: "20", title: "Invoices" },
        ],
      },
    ]);
    const result = await listDatabases("tok", { transport, filter: "report" });
    expect(result.databases.map((d) => d.title)).toEqual(["Reports"]);
  });

  test("ignores non-database results", async () => {
    const transport: NotionDatabasesTransport = async () => ({
      status: 200,
      body: {
        results: [
          { object: "page", id: "p1" },
          { object: "database", id: "10", title: [{ plain_text: "Keep" }] },
        ],
        has_more: false,
      },
    });
    const result = await listDatabases("tok", { transport });
    expect(result.databases.map((d) => d.id)).toEqual(["10"]);
  });

  test("throws with the HTTP status on a non-2xx (token never echoed)", async () => {
    const transport: NotionDatabasesTransport = async () => ({
      status: 404,
      body: { message: "Not Found" },
    });
    await expect(listDatabases("secret-token", { transport })).rejects.toThrow(
      /notion POST \/v1\/search failed: 404 Not Found/,
    );
    await expect(listDatabases("secret-token", { transport })).rejects.not.toThrow(/secret-token/);
  });

  test("renderConfigBlock emits a paste-ready [connectors.notion] databases array", async () => {
    const block = renderConfigBlock({
      databases: [
        { id: "10", title: "Alpha" },
        { id: "11", title: "Beta" },
      ],
    }).join("\n");
    expect(block).toContain("[connectors.notion]");
    expect(block).toContain("enabled = true");
    expect(block).toContain('"10",  # Alpha');
    expect(block).toContain('"11",  # Beta');
  });

  test("renderConfigBlock emits an empty array when nothing is discovered", async () => {
    const block = renderConfigBlock({ databases: [] }).join("\n");
    expect(block).toContain("databases = []");
  });
});
