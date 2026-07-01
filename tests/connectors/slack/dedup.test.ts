import { describe, expect, test } from "bun:test";
import {
  channelOwnership,
  formatSharedChannelWarn,
  ownerAliasForChannels,
  type WorkspaceChannelListing,
} from "../../../src/connectors/slack/dedup.ts";

describe("channelOwnership — owner selection (ADR-0038 §2)", () => {
  test("a shared channel is owned by the lexicographically smallest alias", () => {
    const { owner, shared } = channelOwnership([
      { alias: "employees", channels: ["C1"] },
      { alias: "bp", channels: ["C1"] },
    ]);
    expect(owner.get("C1")).toBe("bp"); // "bp" < "employees"
    expect(shared).toEqual([{ channel: "C1", aliases: ["bp", "employees"], owner: "bp" }]);
  });

  test("owner is independent of workspace declaration order", () => {
    const forward: WorkspaceChannelListing[] = [
      { alias: "employees", channels: ["C1"] },
      { alias: "bp", channels: ["C1"] },
    ];
    const reversed: WorkspaceChannelListing[] = [
      { alias: "bp", channels: ["C1"] },
      { alias: "employees", channels: ["C1"] },
    ];
    expect(channelOwnership(forward).owner.get("C1")).toBe(
      channelOwnership(reversed).owner.get("C1"),
    );
    expect(channelOwnership(forward).owner.get("C1")).toBe("bp");
  });

  test("owner is independent of channel order within an alias", () => {
    const a = channelOwnership([
      { alias: "z", channels: ["C1", "C2"] },
      { alias: "a", channels: ["C2", "C1"] },
    ]);
    expect(a.owner.get("C1")).toBe("a");
    expect(a.owner.get("C2")).toBe("a");
  });

  test("a non-shared channel is owned by its sole alias and is not in `shared`", () => {
    const { owner, shared } = channelOwnership([
      { alias: "acme", channels: ["C1"] },
      { alias: "beta", channels: ["C2"] },
    ]);
    expect(owner.get("C1")).toBe("acme");
    expect(owner.get("C2")).toBe("beta");
    expect(shared).toEqual([]);
  });

  test("a channel repeated within one alias is not treated as shared", () => {
    const { owner, shared } = channelOwnership([{ alias: "acme", channels: ["C1", "C1"] }]);
    expect(owner.get("C1")).toBe("acme");
    expect(shared).toEqual([]);
  });

  test("three aliases share a channel across a Grid → smallest owns, all listed", () => {
    const { owner, shared } = channelOwnership([
      { alias: "gamma", channels: ["C9"] },
      { alias: "alpha", channels: ["C9"] },
      { alias: "beta", channels: ["C9"] },
    ]);
    expect(owner.get("C9")).toBe("alpha");
    expect(shared).toEqual([
      { channel: "C9", aliases: ["alpha", "beta", "gamma"], owner: "alpha" },
    ]);
  });

  test("multiple shared channels are returned ascending by channel id", () => {
    const { shared } = channelOwnership([
      { alias: "b", channels: ["C2", "C1"] },
      { alias: "a", channels: ["C1", "C2"] },
    ]);
    expect(shared.map((s) => s.channel)).toEqual(["C1", "C2"]);
    for (const s of shared) expect(s.owner).toBe("a");
  });

  test("empty input yields no owners and nothing shared", () => {
    const { owner, shared } = channelOwnership([]);
    expect(owner.size).toBe(0);
    expect(shared).toEqual([]);
  });
});

describe("ownerAliasForChannels — convenience map (PR2/PR3 reuse)", () => {
  test("returns just the channel → owner map", () => {
    const map = ownerAliasForChannels([
      { alias: "employees", channels: ["C1"] },
      { alias: "bp", channels: ["C1", "C2"] },
    ]);
    expect(map.get("C1")).toBe("bp");
    expect(map.get("C2")).toBe("bp");
  });
});

describe("formatSharedChannelWarn", () => {
  test("names each shared channel, its aliases, and the chosen owner", () => {
    const msg = formatSharedChannelWarn([
      { channel: "C123", aliases: ["bp", "employees"], owner: "bp" },
    ]);
    expect(msg).toContain("C123 shared across [bp, employees] → ingesting under 'bp'");
    expect(msg).toContain("ADR-0038");
  });

  test("joins multiple shared channels into one line", () => {
    const msg = formatSharedChannelWarn([
      { channel: "C1", aliases: ["a", "b"], owner: "a" },
      { channel: "C2", aliases: ["a", "b"], owner: "a" },
    ]);
    expect(msg).toContain("C1 shared across [a, b] → ingesting under 'a'");
    expect(msg).toContain("C2 shared across [a, b] → ingesting under 'a'");
    expect(msg.split(";")).toHaveLength(2);
  });

  test("empty input yields an empty string", () => {
    expect(formatSharedChannelWarn([])).toBe("");
  });
});
