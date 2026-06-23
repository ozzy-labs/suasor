import { describe, expect, test } from "bun:test";
import type { ActuatorContext } from "../../src/connectors/actuator.ts";
import {
  createGithubActuator,
  type GithubActuatorClient,
  parseIssueExternalId,
  SUASOR_LABEL,
  taskMarker,
} from "../../src/connectors/github-actuator.ts";

/** A recording fake of the GitHub surface the actuator depends on. */
function fakeClient(seed: { existing?: Record<string, number> } = {}) {
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const stateCalls: Array<{ issueNumber: number; state: string; stateReason?: string | null }> = [];
  const comments: Array<{ issueNumber: number; body: string }> = [];
  const projectAdds: Array<{ projectId: string; contentId: string }> = [];
  const statusSets: Array<{
    projectId: string;
    itemId: string;
    fieldId: string;
    optionId: string;
  }> = [];
  const byMarker = new Map<string, number>(Object.entries(seed.existing ?? {}));
  let next = 100;
  const client: GithubActuatorClient = {
    async findIssueByMarker({ marker }) {
      return byMarker.get(marker) ?? null;
    },
    async createIssue({ title, body, labels }) {
      created.push({ title, body, labels });
      const n = next++;
      return { number: n, nodeId: `I_node${n}` };
    },
    async issueNodeId({ issueNumber }) {
      return `I_node${issueNumber}`;
    },
    async setIssueState({ issueNumber, state, stateReason }) {
      stateCalls.push({ issueNumber, state, stateReason });
    },
    async createComment({ issueNumber, body }) {
      comments.push({ issueNumber, body });
    },
    async addToProject({ projectId, contentId }) {
      projectAdds.push({ projectId, contentId });
      return `PVTI_for_${contentId}`;
    },
    async setProjectItemStatus({ projectId, itemId, fieldId, optionId }) {
      statusSets.push({ projectId, itemId, fieldId, optionId });
    },
  };
  return { client, created, stateCalls, comments, projectAdds, statusSets };
}

const ctx: ActuatorContext = { secret: async () => "write-token" };
const boardCfg = {
  repo: "acme/widgets",
  project: "PVT_kw1",
  statusFieldId: "PVTSSF_s",
  doneOptionId: "opt_done",
  todoOptionId: "opt_todo",
};

describe("github-actuator publish (Issue)", () => {
  test("creates an issue with the suasor label + body marker, returns gh externalId", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    const result = await actuator.publish({ taskId: "task-abc", title: "Review spec" }, ctx);
    expect(result.externalId).toBe("gh:acme/widgets:issue:100");
    expect(fake.created[0]?.labels).toEqual([SUASOR_LABEL]);
    expect(fake.created[0]?.body).toContain(taskMarker("task-abc"));
  });

  test("is idempotent on taskId: reuses an existing marked issue, no second create", async () => {
    const fake = fakeClient({ existing: { [taskMarker("task-abc")]: 42 } });
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    const result = await actuator.publish({ taskId: "task-abc", title: "Review spec" }, ctx);
    expect(result.externalId).toBe("gh:acme/widgets:issue:42");
    expect(fake.created).toHaveLength(0);
  });

  test("without a project, does NOT touch any board", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    await actuator.publish({ taskId: "t1", title: "T" }, ctx);
    expect(fake.projectAdds).toHaveLength(0);
  });

  test("throws when the write-scoped token is missing", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    await expect(
      actuator.publish({ taskId: "t", title: "T" }, { secret: async () => null }),
    ).rejects.toThrow(/token/);
  });
});

describe("github-actuator publish (Issue + Projects v2 board)", () => {
  test("adds the created Issue to the configured board by its node id", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator(boardCfg, () => fake.client);
    const result = await actuator.publish({ taskId: "t1", title: "T" }, ctx);
    expect(result.externalId).toBe("gh:acme/widgets:issue:100"); // identity stays the Issue
    expect(fake.projectAdds).toEqual([{ projectId: "PVT_kw1", contentId: "I_node100" }]);
  });
});

describe("github-actuator act (Issue)", () => {
  test("complete closes the issue with state_reason completed", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    await actuator.act("gh:acme/widgets:issue:7", { kind: "complete" }, ctx);
    expect(fake.stateCalls).toEqual([
      { issueNumber: 7, state: "closed", stateReason: "completed" },
    ]);
    expect(fake.statusSets).toHaveLength(0); // no board configured
  });

  test("drop closes the issue as not_planned", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    await actuator.act("gh:acme/widgets:issue:7", { kind: "drop" }, ctx);
    expect(fake.stateCalls).toEqual([
      { issueNumber: 7, state: "closed", stateReason: "not_planned" },
    ]);
  });

  test("comment posts to the (real) issue", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    await actuator.act("gh:acme/widgets:issue:7", { kind: "comment", body: "ping" }, ctx);
    expect(fake.comments).toEqual([{ issueNumber: 7, body: "ping" }]);
  });
});

describe("github-actuator act (Issue + board Status)", () => {
  test("complete also moves the board Status to the done option", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator(boardCfg, () => fake.client);
    await actuator.act("gh:acme/widgets:issue:7", { kind: "complete" }, ctx);
    expect(fake.stateCalls[0]).toMatchObject({ issueNumber: 7, state: "closed" });
    expect(fake.projectAdds).toEqual([{ projectId: "PVT_kw1", contentId: "I_node7" }]);
    expect(fake.statusSets).toEqual([
      {
        projectId: "PVT_kw1",
        itemId: "PVTI_for_I_node7",
        fieldId: "PVTSSF_s",
        optionId: "opt_done",
      },
    ]);
  });

  test("reopen moves the board Status to the todo option", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator(boardCfg, () => fake.client);
    await actuator.act("gh:acme/widgets:issue:7", { kind: "reopen" }, ctx);
    expect(fake.statusSets[0]?.optionId).toBe("opt_todo");
  });

  test("with a project but no status mapping, complete only changes Issue state", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator(
      { repo: "acme/widgets", project: "PVT_kw1" },
      () => fake.client,
    );
    await actuator.act("gh:acme/widgets:issue:7", { kind: "complete" }, ctx);
    expect(fake.statusSets).toHaveLength(0);
  });
});

describe("parseIssueExternalId", () => {
  test("parses owner/repo/number", () => {
    expect(parseIssueExternalId("gh:acme/widgets:issue:42")).toEqual({
      owner: "acme",
      repo: "widgets",
      issueNumber: 42,
    });
  });
  test("throws on a non-issue id", () => {
    expect(() => parseIssueExternalId("gh:notification:abc")).toThrow();
  });
});
