import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlackFetchResult } from "../../src/connectors/slack/_fetch.ts";
import {
  DigestChannelError,
  type DigestPayload,
  deliverToFile,
  deliverToOsNotification,
  deliverToSlackDm,
  osNotificationCommand,
} from "../../src/digest/channels.ts";

const PAYLOAD: DigestPayload = {
  text: "Suasor digest — morning\n\nPriorities (1):\n  1. [overdue] ship it — task overdue\n",
  notification: { title: "Suasor digest — morning", body: "1 priority · top: ship it" },
};

describe("deliverToFile (ADR-0025 sandbox)", () => {
  test("writes the rendered text into the export sandbox", () => {
    const dir = mkdtempSync(join(tmpdir(), "suasor-digest-file-"));
    try {
      const delivery = deliverToFile({ kind: "file", dir, filename: "morning.md" }, PAYLOAD);
      expect(delivery.status).toBe("delivered");
      expect(delivery.detail).toBe(join(dir, "morning.md"));
      expect(readFileSync(join(dir, "morning.md"), "utf8")).toBe(PAYLOAD.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("rejects a filename that is not a plain basename", () => {
    expect(() =>
      deliverToFile({ kind: "file", dir: "/tmp/x", filename: "../escape.md" }, PAYLOAD, {
        writeFile: () => {
          throw new Error("must not write");
        },
        mkdir: () => {},
      }),
    ).toThrow(DigestChannelError);
    try {
      deliverToFile({ kind: "file", dir: "/tmp/x", filename: "sub/dir.md" }, PAYLOAD, {
        writeFile: () => {},
        mkdir: () => {},
      });
      throw new Error("expected throw");
    } catch (err) {
      expect((err as DigestChannelError).code).toBe("INVALID_FILENAME");
    }
  });

  test("refuses an export dir nested under a local connector root (re-ingest loop)", () => {
    try {
      deliverToFile(
        { kind: "file", dir: "/data/local/exports", filename: "d.md", localRoots: ["/data/local"] },
        PAYLOAD,
        { writeFile: () => {}, mkdir: () => {} },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect((err as DigestChannelError).code).toBe("EXPORT_DIR_IN_LOCAL_ROOT");
    }
  });
});

describe("osNotificationCommand", () => {
  const n = { title: "T", body: 'a "quoted" \\ line' };

  test("builds osascript on darwin (AppleScript-escaped)", () => {
    const built = osNotificationCommand("darwin", n);
    expect(built?.command).toBe("osascript");
    expect(built?.args[0]).toBe("-e");
    expect(built?.args[1]).toContain('display notification "a \\"quoted\\" \\\\ line"');
    expect(built?.args[1]).toContain('with title "T"');
  });

  test("builds notify-send on linux with literal args (no shell escaping)", () => {
    const built = osNotificationCommand("linux", n);
    expect(built).toEqual({ command: "notify-send", args: ["T", 'a "quoted" \\ line'] });
  });

  test("builds a PowerShell balloon on win32", () => {
    const built = osNotificationCommand("win32", n);
    expect(built?.command).toBe("powershell");
    expect(built?.args).toContain("-Command");
  });

  test("returns null on an unsupported platform", () => {
    expect(osNotificationCommand("aix" as NodeJS.Platform, n)).toBeNull();
  });
});

describe("deliverToOsNotification", () => {
  test("spawns the notifier and reports delivered on exit 0", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const delivery = await deliverToOsNotification({ kind: "os-notification" }, PAYLOAD, {
      platform: "linux",
      spawn: async (command, args) => {
        calls.push({ command, args });
        return 0;
      },
    });
    expect(delivery.status).toBe("delivered");
    expect(calls[0]?.command).toBe("notify-send");
    expect(calls[0]?.args).toEqual([PAYLOAD.notification.title, PAYLOAD.notification.body]);
  });

  test("fails (structured) when the notifier exits non-zero", async () => {
    const p = deliverToOsNotification({ kind: "os-notification" }, PAYLOAD, {
      platform: "linux",
      spawn: async () => 1,
    });
    await expect(p).rejects.toMatchObject({ code: "OS_NOTIFICATION_FAILED" });
  });

  test("fails (structured) on an unsupported platform", async () => {
    const p = deliverToOsNotification({ kind: "os-notification" }, PAYLOAD, {
      platform: "freebsd",
    });
    await expect(p).rejects.toMatchObject({ code: "OS_NOTIFICATION_UNSUPPORTED" });
  });
});

describe("deliverToSlackDm (ADR-0036 egress)", () => {
  /** A fake slackFetch that answers open + postMessage and records the urls hit. */
  function fakeSlack(
    responses: Record<string, Record<string, unknown>>,
    seen: string[],
  ): (url: string, options: unknown) => Promise<SlackFetchResult> {
    return async (url) => {
      seen.push(url);
      const key = url.includes("conversations.open") ? "open" : "post";
      return { status: 200, headers: new Headers(), body: responses[key] ?? { ok: false } };
    };
  }

  test("opens the self-DM then posts the digest text", async () => {
    const seen: string[] = [];
    const delivery = await deliverToSlackDm(
      { kind: "slack-dm", tokens: ["xoxb-secret"], selfUserId: "U_ME" },
      PAYLOAD,
      {
        slackFetch: fakeSlack(
          { open: { ok: true, channel: { id: "D123" } }, post: { ok: true } },
          seen,
        ),
      },
    );
    expect(delivery.status).toBe("delivered");
    expect(delivery.detail).toBe("dm:D123");
    expect(seen[0]).toContain("conversations.open?users=U_ME");
    expect(seen[1]).toContain("chat.postMessage?channel=D123");
    // The token never leaks into a url (Authorization header carries it).
    expect(seen.join("\n")).not.toContain("xoxb-secret");
  });

  test("missing token → SLACK_TOKEN_NOT_CONFIGURED (no network)", async () => {
    const seen: string[] = [];
    const p = deliverToSlackDm({ kind: "slack-dm", tokens: [], selfUserId: "U_ME" }, PAYLOAD, {
      slackFetch: fakeSlack({}, seen),
    });
    await expect(p).rejects.toMatchObject({ code: "SLACK_TOKEN_NOT_CONFIGURED" });
    expect(seen).toHaveLength(0);
  });

  test("missing self id → SLACK_SELF_ID_NOT_CONFIGURED", async () => {
    const p = deliverToSlackDm({ kind: "slack-dm", tokens: ["xoxb"], selfUserId: "" }, PAYLOAD, {
      slackFetch: fakeSlack({}, []),
    });
    await expect(p).rejects.toMatchObject({ code: "SLACK_SELF_ID_NOT_CONFIGURED" });
  });

  test("a Slack ok:false surfaces as SLACK_API_ERROR", async () => {
    const p = deliverToSlackDm(
      { kind: "slack-dm", tokens: ["xoxb"], selfUserId: "U_ME" },
      PAYLOAD,
      {
        slackFetch: fakeSlack({ open: { ok: false, error: "not_allowed" } }, []),
      },
    );
    await expect(p).rejects.toMatchObject({ code: "SLACK_API_ERROR" });
  });

  test("fails over to the second pool token when the first cannot open the DM (#471)", async () => {
    const tokensSeen: string[] = [];
    const slackFetch = (async (url: string, opts: { token: string }) => {
      tokensSeen.push(opts.token);
      if (opts.token === "tok-wrong") {
        return {
          status: 200,
          headers: new Headers(),
          body: { ok: false, error: "user_not_found" },
        };
      }
      return {
        status: 200,
        headers: new Headers(),
        body: url.includes("conversations.open")
          ? { ok: true, channel: { id: "D9" } }
          : { ok: true },
      };
    }) as unknown as NonNullable<Parameters<typeof deliverToSlackDm>[2]>["slackFetch"];
    const delivery = await deliverToSlackDm(
      { kind: "slack-dm", tokens: ["tok-wrong", "tok-right"], selfUserId: "U_ME" },
      PAYLOAD,
      { slackFetch },
    );
    expect(delivery.status).toBe("delivered");
    // The wrong-workspace token was tried once, then the failover delivered.
    expect(tokensSeen[0]).toBe("tok-wrong");
    expect(tokensSeen).toContain("tok-right");
  });
});
