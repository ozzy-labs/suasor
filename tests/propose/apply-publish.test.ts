import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Actuator } from "../../src/connectors/actuator.ts";
import { Store } from "../../src/db/index.ts";
import { applyAndPublish, type ProposeApplyDeps } from "../../src/propose/apply.ts";
import { proposeGenerate } from "../../src/propose/generate.ts";

let store: Store;
beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

const githubHome = {
  tasks: {
    home: { destination: "github" as const, repo: "acme/widgets" },
    slackListExcludeFromIngest: true,
  },
};

/** Stamp a task candidate (proposeGenerate assigns the content-derived candidateId). */
function taskCandidate(title: string) {
  return proposeGenerate({
    mode: "source_extract",
    candidates: [{ kind: "task", title, sourceExternalIds: [] }],
  }).candidates;
}

function fakeActuator() {
  let n = 0;
  const loader = async (): Promise<Actuator> => ({
    destination: "github",
    async publish() {
      n += 1;
      return { externalId: `gh:acme/widgets:issue:${100 + n}` };
    },
    async act() {},
  });
  return { loader };
}

const deps = (extra: Partial<ProposeApplyDeps> = {}): ProposeApplyDeps => ({
  config: githubHome,
  loadActuatorImpl: fakeActuator().loader,
  ...extra,
});

describe("applyAndPublish (approve & publish, ADR-0036)", () => {
  test("publish=false → applies only, no published field (unchanged behaviour)", async () => {
    const out = await applyAndPublish(
      store,
      { candidates: taskCandidate("t") },
      new Date(),
      deps(),
    );
    expect(out.applied).toBe(1);
    expect(out.published).toBeUndefined();
  });

  test("publish=true → applies and publishes the task to the home", async () => {
    const out = await applyAndPublish(
      store,
      { candidates: taskCandidate("ship it"), publish: true },
      new Date(),
      deps(),
    );
    expect(out.applied).toBe(1);
    expect(out.published).toHaveLength(1);
    expect(out.published?.[0]).toMatchObject({ status: "published" });
    expect(out.published?.[0]?.externalId).toMatch(/^gh:acme\/widgets:issue:/);
    // The task carries the published link.
    const row = store.connection.sqlite
      .query("SELECT published_external_id AS id FROM tasks LIMIT 1")
      .get() as { id: string | null };
    expect(row.id).not.toBeNull();
  });

  test("publish failure is reported per task, never thrown (apply preserved)", async () => {
    const failing: ProposeApplyDeps = {
      config: githubHome,
      loadActuatorImpl: async () => ({
        destination: "github",
        async publish() {
          throw new Error("502 from github");
        },
        async act() {},
      }),
    };
    const out = await applyAndPublish(
      store,
      { candidates: taskCandidate("t"), publish: true },
      new Date(),
      failing,
    );
    expect(out.applied).toBe(1); // apply still succeeded
    expect(out.published?.[0]).toMatchObject({ status: "failed" });
    expect(out.published?.[0]?.error).toMatch(/502/);
  });

  test("no task home configured → tasks reported failed, apply still succeeds", async () => {
    const out = await applyAndPublish(
      store,
      { candidates: taskCandidate("t"), publish: true },
      new Date(),
      { config: {} },
    );
    expect(out.applied).toBe(1);
    expect(out.published?.[0]).toMatchObject({ status: "failed" });
    expect(out.published?.[0]?.error).toMatch(/home/);
  });

  test("non-task candidates are not published", async () => {
    const decision = proposeGenerate({
      mode: "meeting_followup",
      candidates: [{ kind: "decision", title: "go with B", rationale: "", sourceExternalIds: [] }],
    }).candidates;
    const out = await applyAndPublish(
      store,
      { candidates: decision, publish: true },
      new Date(),
      deps(),
    );
    expect(out.applied).toBe(1);
    expect(out.published).toHaveLength(0);
  });
});
