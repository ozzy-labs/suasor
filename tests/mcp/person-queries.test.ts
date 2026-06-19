import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { listPersons } from "../../src/mcp/queries.ts";
import { personMerge } from "../../src/propose/person-merge.ts";
import { personIdFor } from "../../src/projections/person.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function observe(connector: string, handle: string, displayName?: string): string {
  const personId = personIdFor(connector, handle);
  store.record({
    type: "PersonIdentityObserved",
    personId,
    connector,
    handle,
    ...(displayName ? { displayName } : {}),
  });
  return personId;
}

describe("person.list query (ADR-0022)", () => {
  test("lists persons with their identities attached", () => {
    observe("github", "octocat", "Octo Cat");
    observe("slack", "U1");
    const persons = listPersons(store.connection.sqlite);
    expect(persons).toHaveLength(2);
    const gh = persons.find((p) => p.id === personIdFor("github", "octocat"));
    expect(gh?.displayName).toBe("Octo Cat");
    expect(gh?.identityCount).toBe(1);
    expect(gh?.identities).toEqual([
      { connector: "github", handle: "octocat", displayName: "Octo Cat", observedAt: expect.any(String) },
    ]);
  });

  test("hides persons emptied by a merge unless includeEmpty is set", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    personMerge(store, { targetPersonId: gh, sourcePersonId: slack });

    const visible = listPersons(store.connection.sqlite);
    expect(visible.map((p) => p.id)).toEqual([gh]);
    expect(visible[0]?.identities).toHaveLength(2);

    const all = listPersons(store.connection.sqlite, { includeEmpty: true });
    expect(all.map((p) => p.id).sort()).toEqual([gh, slack].sort());
  });

  test("survives a full projection rebuild (replay-identical, FR-MNT-1)", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    personMerge(store, { targetPersonId: gh, sourcePersonId: slack });
    const before = listPersons(store.connection.sqlite, { includeEmpty: true });

    store.rebuild();
    const after = listPersons(store.connection.sqlite, { includeEmpty: true });
    expect(after).toEqual(before);
  });
});
