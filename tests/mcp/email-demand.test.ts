/**
 * Email demand (ADR-0043, Issue #488).
 *
 * The properties worth pinning are the ones that make this different from
 * Slack demand: a row is a *thread*, replying resolves it without an ack, new
 * activity re-raises it, and the noise floor (newsletters, bcc, cc-only) is
 * excluded by construction rather than by a heuristic anyone has to tune.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { buildPriorities, listDemand } from "../../src/mcp/queries.ts";

let store: Store;
const ME = ["me@example.com"];

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

/** Ingest one mail message with connector-neutral meta (ADR-0043 決定 1). */
function mail(
  id: string,
  observedAt: string,
  opts: {
    thread: string;
    from: string;
    to?: string[];
    cc?: string[];
    bulk?: boolean;
    sourceType?: string;
  },
) {
  store.record({
    type: "SourceObserved",
    externalId: id,
    sourceType: opts.sourceType ?? "gmail_message",
    body: `body of ${id}`,
    observedAt,
    fingerprint: id,
    meta: {
      resource: "gmail",
      thread: opts.thread,
      from: opts.from,
      to: opts.to ?? [],
      cc: opts.cc ?? [],
      unread: true,
      bulk: opts.bulk ?? false,
    },
  });
}

function demand(selfAddresses = ME) {
  return listDemand(store.connection.sqlite, { selfAddresses, source: "email" });
}

describe("email demand — what counts (ADR-0043 決定 3)", () => {
  test("an unanswered message addressed to me is demand", () => {
    mail("m1", "2026-07-01T00:00:00.000Z", { thread: "t1", from: "boss@x.com", to: ME });
    const rows = demand();
    expect(rows.map((r) => r.externalId)).toEqual(["m1"]);
    expect(rows[0]?.source).toBe("email");
    expect(rows[0]?.kind).toBe("to");
  });

  test("replying resolves it — no ack required", () => {
    mail("in", "2026-07-01T00:00:00.000Z", { thread: "t1", from: "a@x.com", to: ME });
    expect(demand()).toHaveLength(1);
    // The moment my reply is ingested the predicate breaks. Slack demand needs
    // an explicit ack; here the work itself is the resolution.
    mail("reply", "2026-07-02T00:00:00.000Z", {
      thread: "t1",
      from: ME[0] as string,
      to: ["a@x.com"],
    });
    expect(demand()).toEqual([]);
  });

  test("new activity after my reply raises the thread again", () => {
    mail("in", "2026-07-01T00:00:00.000Z", { thread: "t1", from: "a@x.com", to: ME });
    mail("reply", "2026-07-02T00:00:00.000Z", {
      thread: "t1",
      from: ME[0] as string,
      to: ["a@x.com"],
    });
    mail("chase", "2026-07-03T00:00:00.000Z", { thread: "t1", from: "a@x.com", to: ME });
    // "They followed up" is exactly the thing to re-surface.
    expect(demand().map((r) => r.externalId)).toEqual(["chase"]);
  });

  test("a thread is one row — the newest inbound message represents it", () => {
    mail("first", "2026-07-01T00:00:00.000Z", { thread: "t1", from: "a@x.com", to: ME });
    mail("second", "2026-07-02T00:00:00.000Z", { thread: "t1", from: "a@x.com", to: ME });
    mail("third", "2026-07-03T00:00:00.000Z", { thread: "t1", from: "a@x.com", to: ME });
    // Counting messages would report "3 unprocessed" for one conversation.
    expect(demand().map((r) => r.externalId)).toEqual(["third"]);
  });

  test("cc-only is demand, but classified apart from to", () => {
    mail("m1", "2026-07-01T00:00:00.000Z", { thread: "t1", from: "a@x.com", cc: ME });
    expect(demand()[0]?.kind).toBe("cc");
  });

  test("mail I merely received — not addressed to me — is not demand", () => {
    // bcc and list delivery land in the mailbox without naming me in To/Cc.
    mail("m1", "2026-07-01T00:00:00.000Z", { thread: "t1", from: "a@x.com", to: ["other@x.com"] });
    expect(demand()).toEqual([]);
  });

  test("a newsletter addressed to me is excluded by its list headers", () => {
    mail("news", "2026-07-01T00:00:00.000Z", { thread: "t1", from: "n@x.com", to: ME, bulk: true });
    // Newsletters routinely put you in To; without this the tier refills with
    // exactly the noise ADR-0041 removed.
    expect(demand()).toEqual([]);
  });

  test("my own outbound message is never demand", () => {
    mail("sent", "2026-07-01T00:00:00.000Z", {
      thread: "t1",
      from: ME[0] as string,
      to: ["a@x.com"],
    });
    expect(demand()).toEqual([]);
  });

  test("no self_addresses ⇒ no email demand at all", () => {
    mail("m1", "2026-07-01T00:00:00.000Z", { thread: "t1", from: "a@x.com", to: ME });
    // "Addressed to me" is underivable without knowing who "me" is; the silence
    // is surfaced by doctor rather than guessed at here.
    expect(demand([])).toEqual([]);
  });

  test("outlook mail participates on the same terms", () => {
    mail("m1", "2026-07-01T00:00:00.000Z", {
      thread: "t1",
      from: "a@x.com",
      to: ME,
      sourceType: "ms365_mail",
    });
    const rows = demand();
    expect(rows[0]?.source).toBe("email");
    // The provider stays visible in sourceType — grouped, not erased.
    expect(rows[0]?.sourceType).toBe("ms365_mail");
  });
});

describe("email demand — ranking (ADR-0043 決定 5 / ADR-0045)", () => {
  const NOW = "2026-07-25T00:00:00.000Z";

  test("an unanswered direct mail outranks a fresh slack mention as it ages", () => {
    mail("old-mail", "2026-07-05T00:00:00.000Z", { thread: "t1", from: "boss@x.com", to: ME });
    store.record({
      type: "SourceObserved",
      externalId: "mention",
      sourceType: "slack_message",
      body: "ping <@U_ME>",
      observedAt: "2026-07-24T00:00:00.000Z",
      fingerprint: "mention",
      meta: { channel: "C1" },
    });

    const { items } = buildPriorities(store.connection.sqlite, {
      now: NOW,
      selfAddresses: ME,
      selfUserIds: ["U_ME"],
    });
    // Opposite-signed time terms: the mention decays, the unanswered mail
    // sharpens. Under the old tier ladder both sat in one freshness-ordered
    // tier, so the 20-day-old mail was simply last.
    expect(items[0]?.id).toBe("old-mail");
    expect(items[0]?.reason).toBe("aging");
    expect(items[0]?.explanation).toContain("20 日未返信");
  });

  test("cc mail does not age — it decays like a mention", () => {
    mail("cc-old", "2026-07-05T00:00:00.000Z", { thread: "t1", from: "a@x.com", cc: ME });
    const { items } = buildPriorities(store.connection.sqlite, { now: NOW, selfAddresses: ME });
    // Promoting cc by age would refill the tier with things nobody expects an
    // answer to (ADR-0043 決定 5).
    expect(items[0]?.reason).toBe("unacked_demand");
  });
});
