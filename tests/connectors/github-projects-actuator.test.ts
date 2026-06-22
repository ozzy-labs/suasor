import { describe, expect, test } from "bun:test";
import type { ActuatorContext } from "../../src/connectors/actuator.ts";
import { taskMarker } from "../../src/connectors/github-actuator.ts";
import {
  createGithubProjectsActuator,
  type GithubProjectsClient,
  parseProjectItemExternalId,
} from "../../src/connectors/github-projects-actuator.ts";

function fakeClient(seed: { existing?: Record<string, string> } = {}) {
  const drafts: Array<{ title: string; body: string }> = [];
  const fieldSets: Array<{ itemId: string; fieldId: string; optionId: string }> = [];
  const byMarker = new Map<string, string>(Object.entries(seed.existing ?? {}));
  let next = 1;
  const client: GithubProjectsClient = {
    async findDraftItemByMarker({ marker }) {
      return byMarker.get(marker) ?? null;
    },
    async addDraftIssue({ title, body }) {
      drafts.push({ title, body });
      return `PVTI_item${next++}`;
    },
    async setSingleSelectField({ itemId, fieldId, optionId }) {
      fieldSets.push({ itemId, fieldId, optionId });
    },
  };
  return { client, drafts, fieldSets };
}

const ctx: ActuatorContext = { secret: async () => "write-token" };
const PROJECT = "PVT_kw123";
const statusCfg = {
  project: PROJECT,
  statusFieldId: "PVTSSF_status",
  doneOptionId: "opt_done",
  todoOptionId: "opt_todo",
};

describe("github-projects-actuator publish", () => {
  test("adds a draft issue with the body marker, returns ghp externalId", async () => {
    const fake = fakeClient();
    const actuator = createGithubProjectsActuator({ project: PROJECT }, () => fake.client);
    const result = await actuator.publish({ taskId: "t1", title: "Review" }, ctx);
    expect(result.externalId).toBe(`ghp:${PROJECT}:item:PVTI_item1`);
    expect(fake.drafts).toHaveLength(1);
    expect(fake.drafts[0]?.body).toContain(taskMarker("t1"));
    expect(fake.drafts[0]?.title).toBe("Review");
  });

  test("idempotent: reuses an existing draft item for the same task", async () => {
    const fake = fakeClient({ existing: { [taskMarker("t1")]: "PVTI_existing" } });
    const actuator = createGithubProjectsActuator({ project: PROJECT }, () => fake.client);
    const result = await actuator.publish({ taskId: "t1", title: "Review" }, ctx);
    expect(result.externalId).toBe(`ghp:${PROJECT}:item:PVTI_existing`);
    expect(fake.drafts).toHaveLength(0);
  });

  test("throws when the write-scoped token is missing", async () => {
    const fake = fakeClient();
    const actuator = createGithubProjectsActuator({ project: PROJECT }, () => fake.client);
    await expect(
      actuator.publish({ taskId: "t", title: "T" }, { secret: async () => null }),
    ).rejects.toThrow(/token/);
  });
});

describe("github-projects-actuator act", () => {
  test("complete sets the Status field to the done option", async () => {
    const fake = fakeClient();
    const actuator = createGithubProjectsActuator(statusCfg, () => fake.client);
    await actuator.act(`ghp:${PROJECT}:item:PVTI_5`, { kind: "complete" }, ctx);
    expect(fake.fieldSets).toEqual([
      { itemId: "PVTI_5", fieldId: "PVTSSF_status", optionId: "opt_done" },
    ]);
  });

  test("reopen sets the Status field to the todo option", async () => {
    const fake = fakeClient();
    const actuator = createGithubProjectsActuator(statusCfg, () => fake.client);
    await actuator.act(`ghp:${PROJECT}:item:PVTI_5`, { kind: "reopen" }, ctx);
    expect(fake.fieldSets[0]?.optionId).toBe("opt_todo");
  });

  test("complete without statusFieldId/doneOptionId throws a descriptive error", async () => {
    const fake = fakeClient();
    const actuator = createGithubProjectsActuator({ project: PROJECT }, () => fake.client);
    await expect(
      actuator.act(`ghp:${PROJECT}:item:PVTI_5`, { kind: "complete" }, ctx),
    ).rejects.toThrow(/statusFieldId/);
  });

  test("comment is unsupported for Projects v2 draft issues", async () => {
    const fake = fakeClient();
    const actuator = createGithubProjectsActuator(statusCfg, () => fake.client);
    await expect(
      actuator.act(`ghp:${PROJECT}:item:PVTI_5`, { kind: "comment", body: "x" }, ctx),
    ).rejects.toThrow(/comment is not supported/);
  });
});

describe("parseProjectItemExternalId", () => {
  test("parses projectId + itemId", () => {
    expect(parseProjectItemExternalId("ghp:PVT_kw1:item:PVTI_9")).toEqual({
      projectId: "PVT_kw1",
      itemId: "PVTI_9",
    });
  });
  test("throws on a non-projects id", () => {
    expect(() => parseProjectItemExternalId("gh:o/r:issue:1")).toThrow();
  });
});
