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
    home: { destination: "github", repo: "acme/widgets" },
    slackListExcludeFromIngest: true,
  },
};

/** A fake actuator + injectable loader for the service. */
function fakeActuator() {
  const acts: Array<{ externalId: string; kind: string }> = [];
  let publishCount = 0;
  const actuator: Actuator = {
    destination: "github",
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
