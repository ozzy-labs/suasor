import { describe, expect, test } from "bun:test";
import type { ActuatorContext } from "../../src/connectors/actuator.ts";
import {
  createGithubActuator,
  type GithubActuatorClient,
  parseIssueExternalId,
  SUASOR_LABEL,
  taskMarker,
} from "../../src/connectors/github-actuator.ts";

/** A recording fake of the GitHub REST surface the actuator depends on. */
function fakeClient(seed: { existing?: Record<string, number> } = {}) {
  const created: Array<{ title: string; body: string; labels: string[] }> = [];
  const stateCalls: Array<{ issueNumber: number; state: string; stateReason?: string | null }> = [];
  const comments: Array<{ issueNumber: number; body: string }> = [];
  const byMarker = new Map<string, number>(Object.entries(seed.existing ?? {}));
  let next = 100;
  const client: GithubActuatorClient = {
    async findIssueByMarker({ marker }) {
      return byMarker.get(marker) ?? null;
    },
    async createIssue({ title, body, labels }) {
      created.push({ title, body, labels });
      const n = next++;
      return n;
    },
    async setIssueState({ issueNumber, state, stateReason }) {
      stateCalls.push({ issueNumber, state, stateReason });
    },
    async createComment({ issueNumber, body }) {
      comments.push({ issueNumber, body });
    },
  };
  return { client, created, stateCalls, comments };
}

const ctx: ActuatorContext = { secret: async () => "write-token" };

describe("github-actuator publish", () => {
  test("creates an issue with the suasor label + body marker, returns gh externalId", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);

    const result = await actuator.publish({ taskId: "task-abc", title: "Review spec" }, ctx);

    expect(result.externalId).toBe("gh:acme/widgets:issue:100");
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]?.labels).toEqual([SUASOR_LABEL]);
    expect(fake.created[0]?.body).toContain(taskMarker("task-abc"));
    expect(fake.created[0]?.title).toBe("Review spec");
  });

  test("is idempotent on taskId: reuses an existing marked issue, no second create", async () => {
    const fake = fakeClient({ existing: { [taskMarker("task-abc")]: 42 } });
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);

    const result = await actuator.publish({ taskId: "task-abc", title: "Review spec" }, ctx);

    expect(result.externalId).toBe("gh:acme/widgets:issue:42");
    expect(fake.created).toHaveLength(0); // no duplicate
  });

  test("includes the provenance body above the marker", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    await actuator.publish({ taskId: "t1", title: "T", body: "from: email#1" }, ctx);
    expect(fake.created[0]?.body).toBe(`from: email#1\n\n${taskMarker("t1")}`);
  });

  test("throws when the write-scoped token is missing", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    const noToken: ActuatorContext = { secret: async () => null };
    await expect(actuator.publish({ taskId: "t", title: "T" }, noToken)).rejects.toThrow(/token/);
  });
});

describe("github-actuator act", () => {
  test("complete closes the issue with state_reason completed", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    await actuator.act("gh:acme/widgets:issue:7", { kind: "complete" }, ctx);
    expect(fake.stateCalls).toEqual([
      { issueNumber: 7, state: "closed", stateReason: "completed" },
    ]);
  });

  test("reopen sets state open", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    await actuator.act("gh:acme/widgets:issue:7", { kind: "reopen" }, ctx);
    expect(fake.stateCalls[0]).toMatchObject({ issueNumber: 7, state: "open" });
  });

  test("comment posts the body", async () => {
    const fake = fakeClient();
    const actuator = createGithubActuator({ repo: "acme/widgets" }, () => fake.client);
    await actuator.act("gh:acme/widgets:issue:7", { kind: "comment", body: "ping" }, ctx);
    expect(fake.comments).toEqual([{ issueNumber: 7, body: "ping" }]);
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
    expect(() => parseIssueExternalId("jira:ACME-1")).toThrow();
  });
});
