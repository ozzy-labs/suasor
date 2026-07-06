import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Actuator } from "../../src/connectors/actuator.ts";
import { Store } from "../../src/db/index.ts";
import { McpToolError } from "../../src/mcp/errors.ts";
import { taskCreate } from "../../src/propose/task-create.ts";
import { type TaskHomeConfig, taskAct, taskPublish } from "../../src/propose/task-publish.ts";

let store: Store;

beforeEach(() => {
  store = Store.open({ path: ":memory:" });
});
afterEach(() => {
  store.close();
});

const githubHome: TaskHomeConfig = {
  tasks: {
    homes: { github: { repo: "acme/widgets" } },
    default: "github",
    slackListExcludeFromIngest: true,
  },
};

/** A fake actuator + injectable loader for the service. */
function fakeActuator(destination: "github" | "jira" | "slack" = "github") {
  const acts: Array<{ externalId: string; kind: string }> = [];
  let publishCount = 0;
  const actuator: Actuator = {
    destination,
    async publish() {
      publishCount++;
      return { externalId: `gh:acme/widgets:issue:${100 + publishCount}` };
    },
    async act(externalId, action) {
      acts.push({ externalId, kind: action.kind });
    },
  };
  const loader = async () => actuator;
  return {
    actuator,
    loader,
    acts,
    get publishCount() {
      return publishCount;
    },
  };
}

function row(id: string) {
  return store.connection.sqlite
    .query(
      "SELECT published_destination, published_external_id, published_at FROM tasks WHERE id = ?",
    )
    .get(id) as {
    published_destination: string | null;
    published_external_id: string | null;
    published_at: string | null;
  } | null;
}

describe("task.publish", () => {
  test("publishes a task: actuator called, TaskPublished folded onto the row", async () => {
    const { taskId } = taskCreate(store, { title: "Review spec" });
    const fake = fakeActuator();

    const out = await taskPublish(store, githubHome, { taskId }, new Date(), fake.loader);

    expect(out.status).toBe("published");
    expect(out.externalId).toBe("gh:acme/widgets:issue:101");
    const r = row(taskId);
    expect(r?.published_destination).toBe("github");
    expect(r?.published_external_id).toBe("gh:acme/widgets:issue:101");
    expect(r?.published_at).not.toBeNull();
  });

  test("idempotent: re-publishing an already-published task is a no-op (no second egress)", async () => {
    const { taskId } = taskCreate(store, { title: "Review spec" });
    const fake = fakeActuator();
    await taskPublish(store, githubHome, { taskId }, new Date(), fake.loader);
    const out2 = await taskPublish(store, githubHome, { taskId }, new Date(), fake.loader);
    expect(out2.status).toBe("existing");
    expect(fake.publishCount).toBe(1); // not called again
  });

  test("ACTUATOR_NOT_CONFIGURED when no home is set", async () => {
    const { taskId } = taskCreate(store, { title: "t" });
    const fake = fakeActuator();
    const err = (await taskPublish(store, {}, { taskId }, new Date(), fake.loader).catch(
      (e) => e,
    )) as McpToolError;
    expect(err).toBeInstanceOf(McpToolError);
    expect(err.code).toBe("ACTUATOR_NOT_CONFIGURED");
  });

  test("MISSING_ENTITY for an unknown task", async () => {
    const fake = fakeActuator();
    const err = (await taskPublish(
      store,
      githubHome,
      { taskId: "nope" },
      new Date(),
      fake.loader,
    ).catch((e) => e)) as McpToolError;
    expect(err.code).toBe("MISSING_ENTITY");
  });

  test("EGRESS_FAILED when the actuator throws", async () => {
    const { taskId } = taskCreate(store, { title: "t" });
    const loader = async (): Promise<Actuator> => ({
      destination: "github",
      async publish() {
        throw new Error("502 from github");
      },
      async act() {},
    });
    const err = (await taskPublish(store, githubHome, { taskId }, new Date(), loader).catch(
      (e) => e,
    )) as McpToolError;
    expect(err.code).toBe("EGRESS_FAILED");
    // No event recorded on failure (order: external write → only then append).
    expect(row(taskId)?.published_external_id).toBeNull();
  });
});

describe("task.act", () => {
  test("INVALID_STATE when the task is not published", async () => {
    const { taskId } = taskCreate(store, { title: "t" });
    const fake = fakeActuator();
    const err = (await taskAct(
      store,
      githubHome,
      { taskId, action: "complete" },
      new Date(),
      fake.loader,
    ).catch((e) => e)) as McpToolError;
    expect(err.code).toBe("INVALID_STATE");
  });

  test("complete issues the action to the actuator after publish", async () => {
    const { taskId } = taskCreate(store, { title: "t" });
    const fake = fakeActuator();
    await taskPublish(store, githubHome, { taskId }, new Date(), fake.loader);
    const out = await taskAct(
      store,
      githubHome,
      { taskId, action: "complete" },
      new Date(),
      fake.loader,
    );
    expect(out.action).toBe("complete");
    expect(fake.acts).toEqual([{ externalId: "gh:acme/widgets:issue:101", kind: "complete" }]);
  });

  test("INVALID_INPUT when comment has no body", async () => {
    const { taskId } = taskCreate(store, { title: "t" });
    const fake = fakeActuator();
    await taskPublish(store, githubHome, { taskId }, new Date(), fake.loader);
    const err = (await taskAct(
      store,
      githubHome,
      { taskId, action: "comment" },
      new Date(),
      fake.loader,
    ).catch((e) => e)) as McpToolError;
    expect(err.code).toBe("INVALID_INPUT");
  });
});

describe("ADR-0036 R1: per-destination homes + published_destination-keyed resolution", () => {
  /**
   * A loader that records the (destination, slice) it is built with, so a test
   * can assert the config was resolved from the task's OWN destination — the
   * R1-3 critical fix (a switched default must not repoint act/read-back).
   */
  function recordingLoader() {
    const builds: Array<{ destination: string; slice: Record<string, unknown> }> = [];
    const acts: Array<{ externalId: string; kind: string }> = [];
    const loader = async (destination: string, slice: Record<string, unknown>) => {
      builds.push({ destination, slice });
      return {
        destination: destination as "github" | "jira" | "slack",
        async publish() {
          return { externalId: `${destination}:published:1` };
        },
        async act(externalId: string, action: { kind: string }) {
          acts.push({ externalId, kind: action.kind });
        },
      } as Actuator;
    };
    return { loader, builds, acts };
  }

  test("R1-2: task.publish honours an explicit destination over the default", async () => {
    const { taskId } = taskCreate(store, { title: "route me" });
    // default is github, but publish explicitly to jira.
    const config: TaskHomeConfig = {
      tasks: {
        homes: {
          github: { repo: "acme/widgets" },
          jira: { host: "acme.atlassian.net", project: "ENG" },
        },
        default: "github",
        slackListExcludeFromIngest: true,
      },
    };
    const rec = recordingLoader();
    const out = await taskPublish(
      store,
      config,
      { taskId, destination: "jira" },
      new Date(),
      rec.loader,
    );
    expect(out.destination).toBe("jira");
    expect(rec.builds[0]?.destination).toBe("jira");
    expect(rec.builds[0]?.slice).toMatchObject({ host: "acme.atlassian.net", project: "ENG" });
    expect(row(taskId)?.published_destination).toBe("jira");
  });

  test("R1-2: task.publish falls back to [tasks].default when no destination is given", async () => {
    const { taskId } = taskCreate(store, { title: "default me" });
    const config: TaskHomeConfig = {
      tasks: {
        homes: { github: { repo: "acme/widgets" }, jira: { host: "h", project: "ENG" } },
        default: "jira",
        slackListExcludeFromIngest: true,
      },
    };
    const rec = recordingLoader();
    const out = await taskPublish(store, config, { taskId }, new Date(), rec.loader);
    expect(out.destination).toBe("jira");
    expect(rec.builds[0]?.destination).toBe("jira");
  });

  test("ACTUATOR_NOT_CONFIGURED when a default is set but its home slice is missing", async () => {
    const { taskId } = taskCreate(store, { title: "t" });
    const config: TaskHomeConfig = {
      tasks: { homes: {}, default: "github", slackListExcludeFromIngest: true },
    };
    const rec = recordingLoader();
    const err = (await taskPublish(store, config, { taskId }, new Date(), rec.loader).catch(
      (e) => e,
    )) as McpToolError;
    expect(err.code).toBe("ACTUATOR_NOT_CONFIGURED");
    expect(err.message).toMatch(/github/);
  });

  test("ACTUATOR_NOT_CONFIGURED when neither a destination arg nor a default is set", async () => {
    const { taskId } = taskCreate(store, { title: "t" });
    const config: TaskHomeConfig = {
      tasks: {
        homes: { github: { repo: "acme/widgets" } },
        default: null,
        slackListExcludeFromIngest: true,
      },
    };
    const rec = recordingLoader();
    const err = (await taskPublish(store, config, { taskId }, new Date(), rec.loader).catch(
      (e) => e,
    )) as McpToolError;
    expect(err.code).toBe("ACTUATOR_NOT_CONFIGURED");
  });

  test("R1-3 (critical): switched home — a jira-published task still acts against jira after the default flips to github", async () => {
    // Publish while the default is jira.
    const { taskId } = taskCreate(store, { title: "old jira task" });
    const jiraDefault: TaskHomeConfig = {
      tasks: {
        homes: { jira: { host: "acme.atlassian.net", project: "ENG" } },
        default: "jira",
        slackListExcludeFromIngest: true,
      },
    };
    const pub = recordingLoader();
    const published = await taskPublish(store, jiraDefault, { taskId }, new Date(), pub.loader);
    expect(published.destination).toBe("jira");
    expect(row(taskId)?.published_destination).toBe("jira");
    const externalId = row(taskId)?.published_external_id as string;

    // The user switches the DEFAULT to github (adds a github home, keeps jira).
    const switched: TaskHomeConfig = {
      tasks: {
        homes: {
          github: { repo: "acme/widgets" },
          jira: { host: "acme.atlassian.net", project: "ENG" },
        },
        default: "github",
        slackListExcludeFromIngest: true,
      },
    };

    // Acting on the OLD task must resolve the JIRA home (its own destination),
    // NOT the current github default — this is the regression the fix guards.
    const act = recordingLoader();
    const out = await taskAct(
      store,
      switched,
      { taskId, action: "complete" },
      new Date(),
      act.loader,
    );
    expect(out.action).toBe("complete");
    expect(act.builds).toHaveLength(1);
    expect(act.builds[0]?.destination).toBe("jira");
    expect(act.builds[0]?.slice).toMatchObject({ host: "acme.atlassian.net", project: "ENG" });
    expect(act.acts).toEqual([{ externalId, kind: "complete" }]);
  });

  test("R1-3: acting on a task whose home was removed fails ACTUATOR_NOT_CONFIGURED (not a wrong-home write)", async () => {
    const { taskId } = taskCreate(store, { title: "orphaned home" });
    const jiraDefault: TaskHomeConfig = {
      tasks: {
        homes: { jira: { host: "acme.atlassian.net", project: "ENG" } },
        default: "jira",
        slackListExcludeFromIngest: true,
      },
    };
    const pub = recordingLoader();
    await taskPublish(store, jiraDefault, { taskId }, new Date(), pub.loader);

    // The jira home is dropped entirely, only github remains.
    const githubOnly: TaskHomeConfig = {
      tasks: {
        homes: { github: { repo: "acme/widgets" } },
        default: "github",
        slackListExcludeFromIngest: true,
      },
    };
    const act = recordingLoader();
    const err = (await taskAct(
      store,
      githubOnly,
      { taskId, action: "complete" },
      new Date(),
      act.loader,
    ).catch((e) => e)) as McpToolError;
    expect(err.code).toBe("ACTUATOR_NOT_CONFIGURED");
    // Never fell through to a github write.
    expect(act.builds).toHaveLength(0);
  });
});
