import { describe, expect, test } from "bun:test";
import { newEventId } from "../../src/events/id.ts";

/** Crockford base32 (no I, L, O, U). */
const CROCKFORD = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

describe("newEventId", () => {
  test("a later timestamp sorts lexically after an earlier one", () => {
    // The fixed-width base32 time prefix is what makes the id sortable by
    // creation time — the property the event store documents and relies on.
    expect(newEventId(1_000) < newEventId(2_000)).toBe(true);
  });

  test("monotonic timestamps yield lexically increasing ids", () => {
    const ids = [10, 20, 30, 40, 50].map((t) => newEventId(t * 1_000_000));
    expect(ids).toEqual([...ids].sort());
  });

  test("two ids from the same timestamp still differ (random suffix)", () => {
    expect(newEventId(1_000)).not.toBe(newEventId(1_000));
  });

  test("ids are 26 Crockford base32 chars", () => {
    expect(newEventId(1_700_000_000_000)).toMatch(CROCKFORD);
  });
});
