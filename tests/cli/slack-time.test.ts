/**
 * Human-readable Slack timestamp formatting (#84). Slack `ts` values are epoch
 * seconds with a microsecond fraction; the operational CLI renders them as a
 * local "YYYY-MM-DD HH:MM (<relative>)" column with `now` injected so the
 * relative phrasing is deterministic.
 */
import { describe, expect, test } from "bun:test";
import { formatSlackTs, parseSlackTsMs, relativeTime } from "../../src/cli/slack-time.ts";

describe("parseSlackTsMs", () => {
  test("parses epoch seconds with a microsecond fraction to milliseconds", () => {
    expect(parseSlackTsMs("1718800000.001200")).toBe(1_718_800_000_001);
  });

  test("parses an integer-second ts", () => {
    expect(parseSlackTsMs("111.000000")).toBe(111_000);
  });

  test("returns null for a non-numeric ts (kept raw by the caller)", () => {
    expect(parseSlackTsMs("not-a-ts")).toBeNull();
    expect(parseSlackTsMs("")).toBeNull();
  });
});

describe("relativeTime", () => {
  const base = Date.parse("2026-06-19T12:00:00Z");

  test("under a minute reads 'just now'", () => {
    expect(relativeTime(base - 30_000, base)).toBe("just now");
  });

  test("minutes are pluralized", () => {
    expect(relativeTime(base - 60_000, base)).toBe("1 minute ago");
    expect(relativeTime(base - 5 * 60_000, base)).toBe("5 minutes ago");
  });

  test("hours and days are coarse-grained and pluralized", () => {
    expect(relativeTime(base - 3_600_000, base)).toBe("1 hour ago");
    expect(relativeTime(base - 3 * 86_400_000, base)).toBe("3 days ago");
  });

  test("a future instant (clock skew / index lag) phrases as 'in …'", () => {
    expect(relativeTime(base + 2 * 86_400_000, base)).toBe("in 2 days");
  });
});

describe("formatSlackTs", () => {
  test("renders 'YYYY-MM-DD HH:MM (<relative>)' with an injected clock", () => {
    const now = () => Date.parse("2026-06-19T12:00:00Z");
    // 3 days before `now`, expressed as a Slack ts.
    const ts = `${(now() - 3 * 86_400_000) / 1000}.000000`;
    const out = formatSlackTs(ts, now);
    expect(out).toContain("(3 days ago)");
    // Date prefix is present (exact HH:MM depends on the local timezone).
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(3 days ago\)$/);
  });

  test("returns a non-numeric value unchanged (never swallowed)", () => {
    expect(formatSlackTs("weird-cursor")).toBe("weird-cursor");
  });
});
