import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Store } from "../../src/db/index.ts";
import { persistProposals } from "../../src/propose/generate.ts";
import { taskCreate } from "../../src/propose/task-create.ts";

let store: Store;
beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

/** Mark a task as published (sets tasks.published_external_id + published_to link). */
function publish(taskId: string, externalId: string) {
  store.record({
    type: "TaskPublished",
    taskId,
    destination: "github",
    externalId,
    publishedAt: "2026-06-23T00:00:00+00:00",
  });
}

function generate(sourceExternalIds: string[]) {
  return persistProposals(store, {
    mode: "source_extract",
    candidates: [{ kind: "task", title: "Re-proposed?", sourceExternalIds }],
  });
}

describe("persistProposals — published-task source skip (ADR-0036 §8)", () => {
  test("skips a candidate whose source is a published task's external item", () => {
    const { taskId } = taskCreate(store, { title: "t" });
    publish(taskId, "gh:acme/widgets:issue:5");

    const out = generate(["gh:acme/widgets:issue:5"]);

    expect(out.skipped).toBe(1);
    expect(out.candidates).toHaveLength(0);
    // No ProposalGenerated ledger row was written for the skipped candidate.
    const proposals = store.connection.sqlite
      .query("SELECT COUNT(*) AS n FROM proposals")
      .get() as {
      n: number;
    };
    expect(proposals.n).toBe(0);
  });

  test("keeps a candidate whose source is not a published task", () => {
    const { taskId } = taskCreate(store, { title: "t" });
    publish(taskId, "gh:acme/widgets:issue:5");

    const out = generate(["gh:acme/widgets:issue:999"]);

    expect(out.skipped).toBe(0);
    expect(out.candidates).toHaveLength(1);
  });

  test("no published tasks → nothing skipped (unchanged behaviour)", () => {
    const out = generate(["gh:acme/widgets:issue:5"]);
    expect(out.skipped).toBe(0);
    expect(out.candidates).toHaveLength(1);
  });
});
