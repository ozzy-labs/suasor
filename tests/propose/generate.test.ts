import { describe, expect, test } from "bun:test";
import { proposeGenerate } from "../../src/propose/generate.ts";

describe("propose.generate (candidate framing)", () => {
  test("stamps each candidate with a stable, content-derived id", () => {
    const out = proposeGenerate({
      mode: "source_extract",
      candidates: [
        { kind: "task", title: "ship it", sourceExternalIds: ["gh:1"] },
        { kind: "decision", title: "use bun", rationale: "fast" },
      ],
    });
    expect(out.mode).toBe("source_extract");
    expect(out.candidates).toHaveLength(2);
    for (const c of out.candidates) {
      expect(c.candidateId).toMatch(/^cand_[0-9a-f]{8}$/);
    }
  });

  test("the same content yields the same candidateId across calls (stable)", () => {
    const input = {
      mode: "source_extract" as const,
      candidates: [{ kind: "task" as const, title: "ship it", sourceExternalIds: ["gh:1"] }],
    };
    const a = proposeGenerate(input);
    const b = proposeGenerate(input);
    expect(a.candidates[0]?.candidateId).toBe(b.candidates[0]?.candidateId ?? "");
  });

  test("source order does not change a task/decision id (sorted provenance)", () => {
    const one = proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "t", sourceExternalIds: ["gh:1", "gh:2"] }],
    });
    const two = proposeGenerate({
      mode: "source_extract",
      candidates: [{ kind: "task", title: "t", sourceExternalIds: ["gh:2", "gh:1"] }],
    });
    expect(one.candidates[0]?.candidateId).toBe(two.candidates[0]?.candidateId ?? "");
  });

  test("persists nothing — it is a pure framing function", () => {
    // No store argument exists: generate cannot write by construction (ADR-0004).
    expect(proposeGenerate.length).toBe(1);
  });

  describe("mode ↔ candidate-kind constraints (skill flows)", () => {
    test("reply_draft mode accepts a reply_draft candidate", () => {
      const out = proposeGenerate({
        mode: "reply_draft",
        candidates: [{ kind: "reply_draft", replyToExternalId: "gh:1", body: "thanks" }],
      });
      expect(out.candidates[0]?.kind).toBe("reply_draft");
    });

    test("reply_draft mode rejects a task candidate", () => {
      expect(() =>
        proposeGenerate({
          mode: "reply_draft",
          candidates: [{ kind: "task", title: "nope" }],
        }),
      ).toThrow(/not valid for mode "reply_draft"/);
    });

    test("meeting_followup rejects a reply_draft candidate (task/decision only)", () => {
      expect(() =>
        proposeGenerate({
          mode: "meeting_followup",
          candidates: [{ kind: "reply_draft", replyToExternalId: "gh:1", body: "x" }],
        }),
      ).toThrow(/not valid for mode "meeting_followup"/);
    });

    test("inbox_triage accepts triage / task / decision candidates", () => {
      const out = proposeGenerate({
        mode: "inbox_triage",
        candidates: [
          { kind: "triage", inboxId: "i1", sourceExternalId: "gh:1", state: "done" },
          { kind: "task", title: "follow up", sourceExternalIds: ["gh:1"] },
          { kind: "decision", title: "decided", rationale: "" },
        ],
      });
      expect(out.candidates.map((c) => c.kind).sort()).toEqual(["decision", "task", "triage"]);
    });

    test("inbox_triage rejects an unknown triage state via schema", () => {
      expect(() =>
        proposeGenerate({
          mode: "inbox_triage",
          // @ts-expect-error invalid triage state
          candidates: [{ kind: "triage", inboxId: "i1", sourceExternalId: "gh:1", state: "open" }],
        }),
      ).toThrow();
    });
  });

  test("rejects an empty candidate list", () => {
    expect(() => proposeGenerate({ mode: "source_extract", candidates: [] })).toThrow();
  });
});
