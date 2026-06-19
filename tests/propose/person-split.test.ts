import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { personMerge } from "../../src/propose/person-merge.ts";
import { personSplit } from "../../src/propose/person-split.ts";
import { identityKey, personIdFor } from "../../src/projections/person.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

function observe(connector: string, handle: string): string {
  const personId = personIdFor(connector, handle);
  store.record({ type: "PersonIdentityObserved", personId, connector, handle });
  return personId;
}

function identityPerson(connector: string, handle: string): string | undefined {
  const row = store.connection.sqlite
    .query<{ person_id: string }, [string]>(
      "SELECT person_id FROM person_identities WHERE identity_key = ?",
    )
    .get(identityKey(connector, handle));
  return row?.person_id;
}

describe("person.split (ADR-0022, #92)", () => {
  test("defaults to the identity's own content-derived person", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    personMerge(store, { targetPersonId: gh, sourcePersonId: slack });
    expect(identityPerson("slack", "U1")).toBe(gh);

    const out = personSplit(store, { connector: "slack", handle: "U1" });
    expect(out.status).toBe("split");
    expect(out.newPersonId).toBe(personIdFor("slack", "U1"));
    expect(identityPerson("slack", "U1")).toBe(personIdFor("slack", "U1"));
  });

  test("can target an explicit person", () => {
    const gh = observe("github", "octocat");
    observe("slack", "U1");
    const out = personSplit(store, {
      connector: "slack",
      handle: "U1",
      newPersonId: gh,
    });
    expect(out.status).toBe("split");
    expect(identityPerson("slack", "U1")).toBe(gh);
  });

  test("rejects an unknown identity", () => {
    expect(() => personSplit(store, { connector: "slack", handle: "ghost" })).toThrow(
      /unknown identity/,
    );
  });

  test("is a no-op when the identity already resolves to the target", () => {
    const gh = observe("github", "octocat");
    // octocat already lives on its own person; splitting to that same person is a no-op.
    const out = personSplit(store, { connector: "github", handle: "octocat", newPersonId: gh });
    expect(out.status).toBe("noop");
  });
});
