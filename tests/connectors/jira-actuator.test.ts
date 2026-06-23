import { describe, expect, test } from "bun:test";
import type { ActuatorContext } from "../../src/connectors/actuator.ts";
import {
  createJiraActuator,
  type JiraActuatorClient,
  parseJiraExternalId,
  SUASOR_LABEL,
  taskLabel,
  textToAdf,
} from "../../src/connectors/jira-actuator.ts";

function fakeClient(seed: { existing?: Record<string, string> } = {}) {
  const created: Array<{
    projectKey: string;
    summary: string;
    issueType: string;
    labels: string[];
  }> = [];
  const transitions: Array<{ issueKey: string; transitionId: string }> = [];
  const comments: Array<{ issueKey: string; body: Record<string, unknown> }> = [];
  const byLabel = new Map<string, string>(Object.entries(seed.existing ?? {}));
  let next = 1;
  const client: JiraActuatorClient = {
    async findIssueByLabel({ label }) {
      return byLabel.get(label) ?? null;
    },
    async createIssue({ projectKey, summary, issueType, labels }) {
      created.push({ projectKey, summary, issueType, labels });
      return `${projectKey}-${next++}`;
    },
    async transition({ issueKey, transitionId }) {
      transitions.push({ issueKey, transitionId });
    },
    async addComment({ issueKey, body }) {
      comments.push({ issueKey, body });
    },
  };
  return { client, created, transitions, comments };
}

const ctx: ActuatorContext = { secret: async () => "api-token" };
const cfg = {
  host: "acme.atlassian.net",
  project: "ENG",
  email: "me@acme.com",
  doneTransitionId: "31",
  reopenTransitionId: "11",
};

describe("jira-actuator publish", () => {
  test("creates an issue (issuetype + suasor labels), returns jira externalId matching the read identity", async () => {
    const fake = fakeClient();
    const actuator = createJiraActuator(cfg, () => fake.client);
    const result = await actuator.publish({ taskId: "t1", title: "Fix bug" }, ctx);
    expect(result.externalId).toBe("jira:acme.atlassian.net:ENG:ENG-1");
    expect(fake.created[0]).toMatchObject({
      projectKey: "ENG",
      summary: "Fix bug",
      issueType: "Task",
    });
    expect(fake.created[0]?.labels).toEqual([SUASOR_LABEL, taskLabel("t1")]);
  });

  test("idempotent: reuses an existing issue carrying the task label", async () => {
    const fake = fakeClient({ existing: { [taskLabel("t1")]: "ENG-42" } });
    const actuator = createJiraActuator(cfg, () => fake.client);
    const result = await actuator.publish({ taskId: "t1", title: "Fix bug" }, ctx);
    expect(result.externalId).toBe("jira:acme.atlassian.net:ENG:ENG-42");
    expect(fake.created).toHaveLength(0);
  });

  test("throws when the token is missing", async () => {
    const fake = fakeClient();
    const actuator = createJiraActuator(cfg, () => fake.client);
    await expect(
      actuator.publish({ taskId: "t", title: "T" }, { secret: async () => null }),
    ).rejects.toThrow(/token/);
  });

  test("throws when email is missing for basic auth", async () => {
    const fake = fakeClient();
    const actuator = createJiraActuator(
      { host: "acme.atlassian.net", project: "ENG" },
      () => fake.client,
    );
    await expect(actuator.publish({ taskId: "t", title: "T" }, ctx)).rejects.toThrow(/email/);
  });
});

describe("jira-actuator act", () => {
  test("complete applies the done transition", async () => {
    const fake = fakeClient();
    const actuator = createJiraActuator(cfg, () => fake.client);
    await actuator.act("jira:acme.atlassian.net:ENG:ENG-5", { kind: "complete" }, ctx);
    expect(fake.transitions).toEqual([{ issueKey: "ENG-5", transitionId: "31" }]);
  });

  test("reopen applies the reopen transition", async () => {
    const fake = fakeClient();
    const actuator = createJiraActuator(cfg, () => fake.client);
    await actuator.act("jira:acme.atlassian.net:ENG:ENG-5", { kind: "reopen" }, ctx);
    expect(fake.transitions[0]?.transitionId).toBe("11");
  });

  test("complete without doneTransitionId throws a descriptive error", async () => {
    const fake = fakeClient();
    const actuator = createJiraActuator(
      { host: "acme.atlassian.net", project: "ENG", email: "me@acme.com" },
      () => fake.client,
    );
    await expect(
      actuator.act("jira:acme.atlassian.net:ENG:ENG-5", { kind: "complete" }, ctx),
    ).rejects.toThrow(/doneTransitionId/);
  });

  test("comment adds an ADF comment", async () => {
    const fake = fakeClient();
    const actuator = createJiraActuator(cfg, () => fake.client);
    await actuator.act("jira:acme.atlassian.net:ENG:ENG-5", { kind: "comment", body: "hi" }, ctx);
    expect(fake.comments[0]?.issueKey).toBe("ENG-5");
    expect(fake.comments[0]?.body).toEqual(textToAdf("hi"));
  });
});

describe("parseJiraExternalId", () => {
  test("parses host (with dots) / project / key", () => {
    expect(parseJiraExternalId("jira:acme.atlassian.net:ENG:ENG-7")).toEqual({
      host: "acme.atlassian.net",
      projectKey: "ENG",
      issueKey: "ENG-7",
    });
  });
  test("throws on a non-jira id", () => {
    expect(() => parseJiraExternalId("gh:o/r:issue:1")).toThrow();
  });
});

describe("textToAdf", () => {
  test("wraps text in a minimal ADF doc", () => {
    expect(textToAdf("x")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
    });
  });
});
