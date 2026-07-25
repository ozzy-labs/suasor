/**
 * Commitment ↔ person identity join + staleness nudges (Issue #443).
 *
 * ADR-0022 declares that identities collapse onto one person and that
 * `person.merge` is how an operator says "these are the same human" — but the
 * commitment ledger stored `person` as a bare string and joined to nothing, so
 * merging two identities left the promises split across both halves, and
 * "what did I promise Tanaka" only matched whichever spelling was recorded.
 *
 * These tests pin the join, the merge cascade, and the two deterministic nudges
 * that replace the ledger's fully pull-only behaviour.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  deriveBriefWarnings,
  deriveCommitmentScanStaleness,
  findDuplicatePersonCandidates,
  listCommitments,
  normalizePersonName,
} from "../../src/mcp/queries.ts";
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

function openCommitment(id: string, person: string | undefined, title = "send the deck"): void {
  store.record({
    type: "CommitmentOpened",
    commitmentId: id,
    title,
    direction: "owed_by_me",
    dueDate: null,
    ...(person !== undefined ? { person } : { person: null }),
    sourceExternalIds: [],
  });
}

describe("commitment ↔ person identity join (Issue #443)", () => {
  test("an identity key resolves to the canonical person, keeping the raw string", () => {
    const personId = observe("slack", "U123", "Tanaka Taro");
    openCommitment("c1", "slack:U123");
    const [c] = listCommitments(store.connection.sqlite);
    expect(c?.personId).toBe(personId);
    // The ledger still reads back the way it was written.
    expect(c?.person).toBe("slack:U123");
    expect(c?.personName).toBe("Tanaka Taro");
  });

  test("a bare handle and a display name both resolve", () => {
    const personId = observe("slack", "U123", "Tanaka Taro");
    openCommitment("c1", "U123");
    openCommitment("c2", "Tanaka Taro", "review the draft");
    const byId = new Map(listCommitments(store.connection.sqlite).map((c) => [c.id, c]));
    expect(byId.get("c1")?.personId).toBe(personId);
    expect(byId.get("c2")?.personId).toBe(personId);
  });

  test("an ambiguous name links to nobody rather than guessing", () => {
    observe("slack", "U1", "Tanaka");
    observe("github", "tanaka2", "Tanaka");
    openCommitment("c1", "Tanaka");
    const [c] = listCommitments(store.connection.sqlite);
    // Attributing a promise to the wrong human is worse than leaving it
    // unlinked — the raw string still displays and still filters.
    expect(c?.personId).toBeNull();
    expect(c?.person).toBe("Tanaka");
  });

  test("an unknown person leaves the row unlinked but intact", () => {
    openCommitment("c1", "someone@example.com");
    const [c] = listCommitments(store.connection.sqlite);
    expect(c?.personId).toBeNull();
    expect(c?.personName).toBeNull();
    expect(c?.person).toBe("someone@example.com");
  });

  test("the person filter matches any alias of the same human", () => {
    observe("slack", "U123", "Tanaka Taro");
    observe("github", "tanaka", "Tanaka Taro");
    const merged = personIdFor("slack", "U123");
    store.record({
      type: "PersonsMerged",
      targetPersonId: merged,
      sourcePersonId: personIdFor("github", "tanaka"),
    });
    openCommitment("c1", "slack:U123");
    openCommitment("c2", "github:tanaka", "review the draft");
    const sqlite = store.connection.sqlite;
    // Every spelling of the query finds both promises.
    for (const query of ["slack:U123", "github:tanaka", "U123", "Tanaka Taro", merged]) {
      expect(
        listCommitments(sqlite, { person: query })
          .map((c) => c.id)
          .sort(),
      ).toEqual(["c1", "c2"]);
    }
  });

  test("an unresolvable filter still matches the exact stored string", () => {
    openCommitment("c1", "someone@example.com");
    openCommitment("c2", "other@example.com", "review the draft");
    const rows = listCommitments(store.connection.sqlite, { person: "someone@example.com" });
    expect(rows.map((c) => c.id)).toEqual(["c1"]);
  });

  test("person.merge cascades the ledger onto the surviving person", () => {
    const target = observe("slack", "U123", "Tanaka Taro");
    const source = observe("github", "tanaka", "tanaka");
    openCommitment("c1", "github:tanaka");
    expect(listCommitments(store.connection.sqlite)[0]?.personId).toBe(source);
    store.record({ type: "PersonsMerged", targetPersonId: target, sourcePersonId: source });
    // Without the cascade the promise would hang off the emptied person — the
    // exact split the merge was performed to undo.
    expect(listCommitments(store.connection.sqlite)[0]?.personId).toBe(target);
  });

  test("person.split moves back only the rows linked through that handle", () => {
    const target = observe("slack", "U123", "Tanaka Taro");
    const source = observe("github", "tanaka", "tanaka");
    openCommitment("c1", "github:tanaka");
    openCommitment("c2", "slack:U123", "review the draft");
    store.record({ type: "PersonsMerged", targetPersonId: target, sourcePersonId: source });
    store.record({
      type: "PersonSplit",
      connector: "github",
      handle: "tanaka",
      newPersonId: source,
    });
    const byId = new Map(listCommitments(store.connection.sqlite).map((c) => [c.id, c]));
    expect(byId.get("c1")?.personId).toBe(source);
    expect(byId.get("c2")?.personId).toBe(target);
  });

  test("a rebuild reproduces the links (replay-safe fold)", async () => {
    observe("slack", "U123", "Tanaka Taro");
    openCommitment("c1", "slack:U123");
    const { rebuildProjections } = await import("../../src/projections/rebuild.ts");
    rebuildProjections(store.connection.sqlite);
    expect(listCommitments(store.connection.sqlite)[0]?.personId).toBe(
      personIdFor("slack", "U123"),
    );
  });
});

describe("duplicate person candidates (Issue #443)", () => {
  test("normalization folds case, width, and repeated whitespace", () => {
    expect(normalizePersonName("Tanaka  Taro")).toBe("tanaka taro");
    expect(normalizePersonName("ＴＡＮＡＫＡ")).toBe("tanaka");
  });

  test("persons whose names collide after normalization are surfaced as candidates", () => {
    observe("slack", "U1", "Tanaka Taro");
    observe("github", "tanaka", "tanaka  taro");
    const candidates = findDuplicatePersonCandidates(store.connection.sqlite);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.normalizedName).toBe("tanaka taro");
    expect(candidates[0]?.persons.map((p) => p.id).sort()).toEqual(
      [personIdFor("slack", "U1"), personIdFor("github", "tanaka")].sort(),
    );
  });

  test("nothing is merged automatically — the candidates stay separate persons", () => {
    observe("slack", "U1", "Tanaka Taro");
    observe("github", "tanaka", "Tanaka Taro");
    // Two people really can share a name, so detection stops at "look at this".
    expect(findDuplicatePersonCandidates(store.connection.sqlite)).toHaveLength(1);
    openCommitment("c1", "slack:U1");
    expect(listCommitments(store.connection.sqlite)[0]?.personId).toBe(personIdFor("slack", "U1"));
  });

  test("distinct names and unnamed persons produce no candidates", () => {
    observe("slack", "U1", "Tanaka");
    observe("github", "octocat", "Octo Cat");
    observe("slack", "U2");
    expect(findDuplicatePersonCandidates(store.connection.sqlite)).toEqual([]);
  });

  test("a merged-away person drops out of the candidate list", () => {
    const target = observe("slack", "U1", "Tanaka Taro");
    const source = observe("github", "tanaka", "Tanaka Taro");
    expect(findDuplicatePersonCandidates(store.connection.sqlite)).toHaveLength(1);
    store.record({ type: "PersonsMerged", targetPersonId: target, sourcePersonId: source });
    expect(findDuplicatePersonCandidates(store.connection.sqlite)).toEqual([]);
  });
});

describe("commitment scan staleness (Issue #443)", () => {
  function ingest(externalId: string, observedAt: string): void {
    store.record({
      type: "SourceObserved",
      externalId,
      sourceType: "slack_message",
      body: "I'll send the deck by Friday",
      observedAt,
      fingerprint: externalId,
      meta: {},
    });
  }

  function proposeCommitment(candidateId: string): void {
    store.record({
      type: "ProposalGenerated",
      candidateId,
      mode: "commitment_scan",
      kind: "commitment",
      entityId: candidateId,
      summary: "send the deck",
      sourceExternalIds: [],
    });
  }

  test("never scanned with material ingested reports every source as unscanned", () => {
    ingest("s1", "2026-07-01T00:00:00.000Z");
    ingest("s2", "2026-07-02T00:00:00.000Z");
    const staleness = deriveCommitmentScanStaleness(store.connection.sqlite);
    expect(staleness.lastScanAt).toBeNull();
    expect(staleness.unscannedSources).toBe(2);
    const [warning] = deriveBriefWarnings({
      slackConfigured: true,
      embeddingBackend: "ollama",
      commitmentScan: staleness,
    });
    expect(warning?.key).toBe("commitment_scan_stale");
    expect(warning?.message).toContain("never scanned");
  });

  test("an empty store is not stale — there is nothing to scan", () => {
    const staleness = deriveCommitmentScanStaleness(store.connection.sqlite);
    expect(staleness.unscannedSources).toBe(0);
    expect(
      deriveBriefWarnings({
        slackConfigured: true,
        embeddingBackend: "ollama",
        commitmentScan: staleness,
      }),
    ).toEqual([]);
  });

  test("sources ingested after the last scan are counted, earlier ones are not", () => {
    ingest("s1", "2026-07-01T00:00:00.000Z");
    proposeCommitment("cand-1");
    const scanAt = deriveCommitmentScanStaleness(store.connection.sqlite).lastScanAt;
    expect(scanAt).not.toBeNull();
    // Ingested strictly after the scan.
    ingest("s2", new Date(Date.now() + 60_000).toISOString());
    const staleness = deriveCommitmentScanStaleness(store.connection.sqlite);
    expect(staleness.unscannedSources).toBe(1);
    const [warning] = deriveBriefWarnings({
      slackConfigured: true,
      embeddingBackend: "ollama",
      commitmentScan: staleness,
    });
    expect(warning?.message).toContain("1 source(s) ingested since the last scan");
  });

  test("a scan newer than every source is current", () => {
    ingest("s1", "2026-07-01T00:00:00.000Z");
    proposeCommitment("cand-1");
    const staleness = deriveCommitmentScanStaleness(store.connection.sqlite);
    expect(staleness.unscannedSources).toBe(0);
    expect(
      deriveBriefWarnings({
        slackConfigured: true,
        embeddingBackend: "ollama",
        commitmentScan: staleness,
      }),
    ).toEqual([]);
  });
});

describe("commitment ledger urgency order (Issue #509)", () => {
  function open(id: string, title: string, dueDate: string | null) {
    store.record({
      type: "CommitmentOpened",
      commitmentId: id,
      title,
      direction: "owed_to_me",
      dueDate,
      person: null,
      sourceExternalIds: [],
    });
  }

  const NOW = "2026-07-25T00:00:00.000Z";

  test("overdue promises come first, longest overdue leading", () => {
    // All three are touched at the same instant, so under the old
    // `updated_at DESC` order the chase-worthy ones sorted arbitrarily — and
    // with a row limit, last.
    open("fresh", "no due date", null);
    open("soon", "due next week", "2026-08-01T00:00:00.000Z");
    open("late-a", "3 days late", "2026-07-22T00:00:00.000Z");
    open("late-b", "3 weeks late", "2026-07-04T00:00:00.000Z");

    const rows = listCommitments(store.connection.sqlite, { state: "open", now: NOW });
    expect(rows.map((r) => r.id)).toEqual(["late-b", "late-a", "soon", "fresh"]);
    expect(rows.map((r) => r.overdue)).toEqual([true, true, false, false]);
  });

  test("undated promises sort last, not into the middle", () => {
    open("undated", "someday", null);
    open("dated", "due next week", "2026-08-01T00:00:00.000Z");
    const rows = listCommitments(store.connection.sqlite, { state: "open", now: NOW });
    expect(rows.map((r) => r.id)).toEqual(["dated", "undated"]);
  });

  test("overdue is read-time derived from the injected now, never stored", () => {
    open("c1", "due 2026-07-22", "2026-07-22T00:00:00.000Z");
    // Before the due date it is not overdue; after, it is — same row, no write.
    expect(
      listCommitments(store.connection.sqlite, { now: "2026-07-20T00:00:00.000Z" })[0]?.overdue,
    ).toBe(false);
    expect(listCommitments(store.connection.sqlite, { now: NOW })[0]?.overdue).toBe(true);
  });

  test("a resolved commitment past its due date is not overdue", () => {
    open("done", "was due", "2026-07-01T00:00:00.000Z");
    store.record({ type: "CommitmentResolved", commitmentId: "done" });
    expect(listCommitments(store.connection.sqlite, { now: NOW })[0]?.overdue).toBe(false);
  });

  test("the overdue filter selects exactly the chase-worthy rows", () => {
    open("late", "late", "2026-07-01T00:00:00.000Z");
    open("soon", "soon", "2026-08-01T00:00:00.000Z");
    open("undated", "undated", null);
    const rows = listCommitments(store.connection.sqlite, { overdue: true, now: NOW });
    expect(rows.map((r) => r.id)).toEqual(["late"]);
  });

  test("dueBefore filters by due date and excludes undated rows", () => {
    open("early", "early", "2026-07-10T00:00:00.000Z");
    open("later", "later", "2026-09-01T00:00:00.000Z");
    open("undated", "undated", null);
    const rows = listCommitments(store.connection.sqlite, {
      dueBefore: "2026-08-01T00:00:00.000Z",
      now: NOW,
    });
    expect(rows.map((r) => r.id)).toEqual(["early"]);
  });

  test("the most chase-worthy row survives a tight limit", () => {
    // The failure this fixes: with updated_at ordering the limit truncated
    // precisely the rows the chase surface exists to find.
    open("late", "3 weeks late", "2026-07-04T00:00:00.000Z");
    for (let i = 0; i < 5; i++) open(`fresh-${i}`, "no due date", null);
    const rows = listCommitments(store.connection.sqlite, { state: "open", now: NOW, limit: 1 });
    expect(rows.map((r) => r.id)).toEqual(["late"]);
  });
});
