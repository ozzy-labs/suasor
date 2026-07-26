/**
 * Calendar proximity demand (ADR-0044, Issue #490 PR3/PR4).
 *
 * What makes calendar different from every other demand source: it needs no
 * ack, because the clock resolves it — an event leaves the window when it
 * starts. And it is the only source whose urgency is *not* a function of when
 * the row was observed (that is the event's modification time), so both the
 * predicate and the ranking read `meta.start` against an injectable `now`.
 *
 * Two windows, not one, is the load-bearing decision (決定 4): preparation has
 * to surface the night before to be actionable, and "time to head out" would be
 * noise at that distance.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import {
  buildBrief,
  buildPriorities,
  listDemand,
  MEETING_PREP_MINUTES,
  MEETING_SOON_MINUTES,
  STARTING_SOON_MINUTES,
} from "../../src/mcp/queries.ts";

let store: Store;

const NOW = "2026-07-25T09:00:00.000Z";

/** An instant `minutes` from {@link NOW}, in the shape both connectors emit. */
function at(minutes: number): string {
  return new Date(new Date(NOW).getTime() + minutes * 60_000).toISOString();
}

/** Ingest one calendar event with connector-neutral meta (ADR-0044 決定 1b). */
function event(
  id: string,
  startsInMinutes: number,
  opts: {
    role?: "organizer" | "required" | "optional" | "none";
    response?: "accepted" | "declined" | "tentative" | "none";
    allDay?: boolean;
    hasAgenda?: boolean;
    hasAttachments?: boolean;
    sourceType?: string;
    /** Modification time — deliberately unrelated to the start time. */
    observedAt?: string;
  } = {},
) {
  store.record({
    type: "SourceObserved",
    externalId: id,
    sourceType: opts.sourceType ?? "google_calendar",
    body: `${id} title\n\nagenda body`,
    observedAt: opts.observedAt ?? "2026-01-01T00:00:00.000Z",
    fingerprint: id,
    meta: {
      resource: "calendar",
      start: at(startsInMinutes),
      end: at(startsInMinutes + 30),
      allDay: opts.allDay ?? false,
      role: opts.role ?? "required",
      response: opts.response ?? "accepted",
      attendees: 3,
      hasAgenda: opts.hasAgenda ?? false,
      hasAttachments: opts.hasAttachments ?? false,
      recurring: false,
    },
  });
}

function demand(options: Parameters<typeof listDemand>[1] = {}) {
  return listDemand(store.connection.sqlite, { now: NOW, source: "calendar", ...options });
}

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});

afterEach(() => {
  store.close();
});

describe("calendar demand — the two windows (ADR-0044 決定 4)", () => {
  test("a meeting inside the soon window is meeting_soon", () => {
    event("m", 45);
    const rows = demand();
    expect(rows.map((r) => r.externalId)).toEqual(["m"]);
    expect(rows[0]?.source).toBe("calendar");
    expect(rows[0]?.kind).toBe("meeting_soon");
  });

  test("the soon window is inclusive at its edge and hands over to prep past it", () => {
    event("edge", MEETING_SOON_MINUTES);
    event("past-edge", MEETING_SOON_MINUTES + 1, { hasAgenda: true });
    const byId = new Map(demand().map((r) => [r.externalId, r.kind]));
    expect(byId.get("edge")).toBe("meeting_soon");
    expect(byId.get("past-edge")).toBe("meeting_prep");
  });

  test("a meeting in both windows is emitted once, as the stronger kind", () => {
    event("m", 20, { hasAgenda: true, role: "organizer" });
    const rows = demand();
    // Counting it twice would double-report one meeting as two things to do.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("meeting_soon");
  });

  test("beyond the soon window, prep needs something to actually prepare", () => {
    event("bare", 300);
    event("agenda", 300, { hasAgenda: true });
    event("attached", 300, { hasAttachments: true });
    event("mine", 300, { role: "organizer" });
    // Without this, every routine standup in the next 24h becomes demand.
    expect(
      demand()
        .map((r) => r.externalId)
        .sort(),
    ).toEqual(["agenda", "attached", "mine"]);
  });

  test("the prep window is inclusive at a day out and stops there", () => {
    event("in", MEETING_PREP_MINUTES, { hasAgenda: true });
    event("out", MEETING_PREP_MINUTES + 1, { hasAgenda: true });
    expect(demand().map((r) => r.externalId)).toEqual(["in"]);
  });

  test("a meeting leaves the list the moment it starts", () => {
    event("now", 0);
    event("started", -1);
    // No ack is needed anywhere here — the clock is the resolution (決定 4).
    expect(demand().map((r) => r.externalId)).toEqual(["now"]);
  });
});

describe("calendar demand — what is excluded (ADR-0044 決定 4)", () => {
  test("a declined meeting is never demand", () => {
    event("no", 45, { response: "declined" });
    // Declining is an explicit answer; re-raising it overrides the operator.
    expect(demand()).toEqual([]);
  });

  test("optional attendance does not occupy the list", () => {
    event("fyi", 45, { role: "optional" });
    event("none", 45, { role: "none" });
    expect(demand()).toEqual([]);
  });

  test("an all-day event has no meaningful proximity", () => {
    event("offsite", 45, { allDay: true });
    // It "starts" at 00:00, so a minutes-to-start signal would be a fiction.
    expect(demand()).toEqual([]);
  });

  test("acking one hides it, like any other demand", () => {
    event("m", 45);
    store.record({ type: "DemandAcknowledged", externalId: "m" });
    expect(demand()).toEqual([]);
    expect(demand({ includeSeen: true })[0]?.seenState).toBe("acked");
  });

  test("outlook calendar participates on the same terms", () => {
    event("m", 45, { sourceType: "ms365_calendar" });
    const rows = demand();
    expect(rows[0]?.source).toBe("calendar");
    // The provider stays visible in sourceType — grouped, not erased.
    expect(rows[0]?.sourceType).toBe("ms365_calendar");
  });
});

describe("calendar demand — ordering and composition", () => {
  test("proximity, not modification time, orders the calendar rows", () => {
    event("later", 90, { observedAt: "2026-07-20T00:00:00.000Z" });
    event("sooner", 20, { observedAt: "2026-01-01T00:00:00.000Z" });
    // Ordering by observed_at would put the recently-edited meeting first —
    // exactly the defect ADR-0044 identified in the meeting-prep skill.
    expect(demand().map((r) => r.externalId)).toEqual(["sooner", "later"]);
  });

  test("calendar leads a mixed list, so limit cannot cut off an imminent meeting", () => {
    event("m", 20);
    store.record({
      type: "SourceObserved",
      externalId: "dm",
      sourceType: "slack_message",
      body: "hi",
      observedAt: "2026-07-25T08:00:00.000Z",
      fingerprint: "dm",
      meta: { channel: "D1" },
    });
    const rows = listDemand(store.connection.sqlite, { now: NOW });
    expect(rows.map((r) => r.externalId)).toEqual(["m", "dm"]);
  });

  test("the kinds filter selects one window without dragging in the other", () => {
    event("soon", 20);
    event("prep", 300, { hasAgenda: true });
    expect(demand({ kinds: ["meeting_soon"] }).map((r) => r.externalId)).toEqual(["soon"]);
    expect(demand({ kinds: ["meeting_prep"] }).map((r) => r.externalId)).toEqual(["prep"]);
  });

  test("brief leaves calendar out — it bundles a window, not a clock", () => {
    // `buildBrief` takes no `now`, so the meeting has to be imminent against the
    // real clock for this to test the exclusion rather than the window.
    event("m", 0, { observedAt: "2026-07-25T08:00:00.000Z" });
    store.record({
      type: "SourceObserved",
      externalId: "m",
      sourceType: "google_calendar",
      body: "m title\n\nagenda",
      observedAt: "2026-07-25T08:00:00.000Z",
      fingerprint: "m2",
      meta: {
        resource: "calendar",
        start: new Date(Date.now() + 20 * 60_000).toISOString(),
        end: new Date(Date.now() + 50 * 60_000).toISOString(),
        allDay: false,
        role: "required",
        response: "accepted",
        attendees: 3,
        hasAgenda: true,
        hasAttachments: false,
        recurring: false,
      },
    });
    const brief = buildBrief(store.connection.sqlite, {
      since: "2026-07-25T00:00:00.000Z",
      until: "2026-07-26T00:00:00.000Z",
    });
    // The window filter is observed_at = the event's *modification* time, so
    // including calendar would answer "which meetings were edited today".
    expect(brief.demand).toEqual([]);
  });
});

describe("calendar proximity in the ranking (ADR-0044 決定 5 / ADR-0045 決定 1)", () => {
  /** An overdue task, the strongest non-calendar signal in the model. */
  function overdueTask(id: string, daysLate: number) {
    store.record({
      type: "TaskProposed",
      taskId: id,
      title: `task ${id}`,
      dueDate: new Date(new Date(NOW).getTime() - daysLate * 86_400_000).toISOString(),
      sourceExternalIds: [],
    });
    store.record({ type: "TaskApplied", taskId: id, state: "open" });
  }

  function ranked() {
    return buildPriorities(store.connection.sqlite, { now: NOW }).items;
  }

  test("a meeting inside the hard window outranks even a badly overdue task", () => {
    event("standup", STARTING_SOON_MINUTES - 10);
    overdueTask("t", 60);
    const items = ranked();
    // The one thing here that cannot be moved: the task can be done in an hour,
    // the meeting happens in 20 minutes or not at all (ADR-0045 決定 1).
    expect(items[0]?.id).toBe("standup");
    expect(items[0]?.reason).toBe("starting_soon");
    expect(items[0]?.explanation).toBe("20 分後に開始");
  });

  test("inside the hard tier, the soonest meeting leads", () => {
    event("second", 25);
    event("first", 5);
    expect(ranked().map((i) => i.id)).toEqual(["first", "second"]);
  });

  test("a hard-tier row still carries a real score", () => {
    event("m", 10);
    // The tier is an ordering override, not a score. Reporting `score: 0` on
    // the row ranked first would read as a bug to anyone inspecting the output.
    expect(ranked()[0]?.score).toBeGreaterThan(0);
  });

  test("outside the hard window a meeting is scored, not enthroned", () => {
    event("m", STARTING_SOON_MINUTES + 1);
    overdueTask("t", 60);
    const items = ranked();
    // A month overdue outweighs a meeting an hour out — the hard tier is a
    // narrow exception, not "calendar wins".
    expect(items[0]?.id).toBe("t");
    expect(items[1]?.reason).toBe("prep");
  });

  test("a meeting three hours out outranks a Slack DM from this morning", () => {
    event("m", 180, { hasAgenda: true });
    store.record({
      type: "SourceObserved",
      externalId: "dm",
      sourceType: "slack_message",
      body: "ping",
      observedAt: "2026-07-25T08:00:00.000Z",
      fingerprint: "dm",
      meta: { channel: "D1" },
    });
    const items = ranked();
    expect(items[0]?.id).toBe("m");
    expect(items[0]?.explanation).toBe("開始まで 3 時間");
  });

  test("approaching a meeting never lowers its score", () => {
    const scoreAt = (minutes: number) => {
      const s = Store.open({ path: ":memory:" });
      const prev = store;
      store = s;
      event("m", minutes, { hasAgenda: true });
      const item = buildPriorities(s.connection.sqlite, { now: NOW }).items[0];
      s.close();
      store = prev;
      return item?.score ?? 0;
    };
    // Monotonic across the whole range, hard tier included — there is no point
    // at which getting closer to a meeting makes it look less urgent.
    const scores = [1400, 720, 180, 60, STARTING_SOON_MINUTES + 1, 10, 0].map(scoreAt);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i]).toBeGreaterThan(scores[i - 1] as number);
    }
  });

  test("the ranking is deterministic under a fixed now", () => {
    event("a", 20);
    event("b", 200, { hasAgenda: true });
    overdueTask("t", 3);
    const first = ranked().map((i) => `${i.id}:${i.reason}:${i.score}`);
    const second = ranked().map((i) => `${i.id}:${i.reason}:${i.score}`);
    expect(second).toEqual(first);
  });

  test("a declined meeting never reaches the ranking at all", () => {
    event("no", 10, { response: "declined" });
    expect(ranked()).toEqual([]);
  });
});
