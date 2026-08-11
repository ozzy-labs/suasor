import { describe, expect, test } from "bun:test";
import { createProgress, type ProgressStream } from "../../src/cli/progress.ts";

/** A fake stream capturing writes, with a settable `isTTY`. */
function fakeStream(isTTY: boolean): ProgressStream & { out: string[] } {
  const out: string[] = [];
  return {
    out,
    isTTY,
    write(s: string) {
      out.push(s);
      return true;
    },
  };
}

describe("createProgress (ADR-0026 parity)", () => {
  test("is a no-op when the stream is not a TTY (CI / pipes)", () => {
    const s = fakeStream(false);
    const p = createProgress(s, "github sync");
    p.tick();
    p.tick();
    p.finish();
    expect(s.out).toEqual([]); // nothing written → no ANSI leaks into captured output
  });

  test("is a no-op when explicitly disabled even on a TTY", () => {
    const s = fakeStream(true);
    const p = createProgress(s, "github sync", false);
    p.tick();
    p.finish();
    expect(s.out).toEqual([]);
  });

  test("renders a throttled counter on a TTY and clears on finish", () => {
    const s = fakeStream(true);
    let clock = 0;
    const p = createProgress(s, "github sync", undefined, () => clock);

    p.tick(); // t=0: 0-0 < 80 → no render (with the real clock the first tick renders)
    clock = 100;
    p.tick(); // t=100: elapsed >= 80 → render "…: 2 processed…"
    clock = 120;
    p.tick(); // t=120: only 20ms since last → throttled, no render
    p.finish();

    const renders = s.out.filter((w) => w.includes("processed"));
    expect(renders.length).toBe(1);
    expect(renders[0]).toContain("github sync: 2 processed");
    // last write clears the line so the stdout summary stays clean
    expect(s.out.at(-1)).toBe("\r\x1b[2K");
  });

  test("renders the running count, not a fixed total", () => {
    const s = fakeStream(true);
    let clock = 0;
    const p = createProgress(s, "x", undefined, () => clock);
    for (let i = 0; i < 5; i += 1) {
      clock += 100; // force a render each tick
      p.tick();
    }
    const renders = s.out.filter((w) => w.includes("processed"));
    expect(renders.at(-1)).toContain("x: 5 processed");
  });

  // Issue #573: `sync` folds the currently-syncing connector names into the label.
  describe("setLabel", () => {
    test("re-renders immediately (unthrottled) with the new label and running count", () => {
      const s = fakeStream(true);
      let clock = 0;
      const p = createProgress(s, "sync", undefined, () => clock);
      clock = 100;
      p.tick(); // renders "sync: 1 processed…"
      clock = 110; // within the throttle window — setLabel must still render
      p.setLabel("sync [slack,notion]");
      const renders = s.out.filter((w) => w.includes("processed"));
      expect(renders.at(-1)).toContain("sync [slack,notion]: 1 processed");
    });

    test("subsequent ticks render under the new label", () => {
      const s = fakeStream(true);
      let clock = 0;
      const p = createProgress(s, "sync", undefined, () => clock);
      p.setLabel("sync [slack]");
      clock = 200;
      p.tick();
      const renders = s.out.filter((w) => w.includes("processed"));
      expect(renders.at(-1)).toContain("sync [slack]: 1 processed");
    });

    test("an unchanged label does not re-render", () => {
      const s = fakeStream(true);
      const p = createProgress(s, "sync", undefined, () => 0);
      p.setLabel("sync");
      expect(s.out).toEqual([]);
    });

    test("is a no-op when the stream is not a TTY", () => {
      const s = fakeStream(false);
      const p = createProgress(s, "sync");
      p.setLabel("sync [slack]");
      p.tick();
      expect(s.out).toEqual([]);
    });
  });
});
