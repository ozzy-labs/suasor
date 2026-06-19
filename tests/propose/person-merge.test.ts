import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { identityKey, personIdFor } from "../../src/projections/person.ts";
import { personMerge } from "../../src/propose/person-merge.ts";
import { personSplit } from "../../src/propose/person-split.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Observe a `(connector, handle)` identity through the event store (1=1). */
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

function identityCount(personId: string): number | undefined {
  const row = store.connection.sqlite
    .query<{ identity_count: number }, [string]>("SELECT identity_count FROM persons WHERE id = ?")
    .get(personId);
  return row?.identity_count;
}

describe("person.merge (ADR-0022, #92)", () => {
  test("reassigns every identity of the source person to the target", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    expect(identityPerson("slack", "U1")).toBe(slack);

    const out = personMerge(store, { targetPersonId: gh, sourcePersonId: slack });
    expect(out.status).toBe("merged");
    expect(out.movedIdentities).toBe(1);

    // Slack identity now resolves to the github person.
    expect(identityPerson("slack", "U1")).toBe(gh);
    expect(identityCount(gh)).toBe(2);
    expect(identityCount(slack)).toBe(0);
  });

  test("rejects a self-merge", () => {
    const gh = observe("github", "octocat");
    expect(() => personMerge(store, { targetPersonId: gh, sourcePersonId: gh })).toThrow(/itself/);
  });

  test("rejects an unknown source person", () => {
    const gh = observe("github", "octocat");
    expect(() =>
      personMerge(store, { targetPersonId: gh, sourcePersonId: "person_deadbeef" }),
    ).toThrow(/unknown source person/);
  });

  test("is a no-op when the source has already been emptied (idempotent)", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    personMerge(store, { targetPersonId: gh, sourcePersonId: slack });
    const again = personMerge(store, { targetPersonId: gh, sourcePersonId: slack });
    expect(again.status).toBe("noop");
    expect(again.movedIdentities).toBe(0);
    expect(identityCount(gh)).toBe(2);
  });

  test("re-observing a merged-away handle keeps it on the merge target", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    personMerge(store, { targetPersonId: gh, sourcePersonId: slack });
    // A later sync observes the same slack handle again — must NOT resurrect the
    // emptied person nor re-point the identity (ADR-0022 idempotence).
    observe("slack", "U1");
    expect(identityPerson("slack", "U1")).toBe(gh);
    expect(identityCount(slack)).toBe(0);
  });

  test("merge then split round-trips (reversible audit, ADR-0022)", () => {
    const gh = observe("github", "octocat");
    const slack = observe("slack", "U1");
    personMerge(store, { targetPersonId: gh, sourcePersonId: slack });
    expect(identityPerson("slack", "U1")).toBe(gh);

    // Split the slack identity back out to its own content-derived person.
    const out = personSplit(store, { connector: "slack", handle: "U1" });
    expect(out.status).toBe("split");
    expect(out.newPersonId).toBe(slack);
    expect(identityPerson("slack", "U1")).toBe(slack);
    expect(identityCount(gh)).toBe(1);
    expect(identityCount(slack)).toBe(1);
  });
});
