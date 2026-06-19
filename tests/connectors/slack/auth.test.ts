import { describe, expect, test } from "bun:test";
import { type SlackAuthTransport, testToken } from "../../../src/connectors/slack/auth.ts";

function fakeAuth(
  body: Record<string, unknown>,
  scopesHeader: string | null,
): { transport: SlackAuthTransport; tokens: string[] } {
  const tokens: string[] = [];
  const transport: SlackAuthTransport = async (token) => {
    tokens.push(token);
    return { body, scopesHeader };
  };
  return { transport, tokens };
}

describe("auth — testToken", () => {
  test("a bot token resolves principal=bot and the granted scopes", async () => {
    const { transport, tokens } = fakeAuth(
      { ok: true, team: "Acme", team_id: "T1", user: "suasor-bot", user_id: "U1", bot_id: "B1" },
      "channels:history,users:read",
    );
    const result = await testToken("xoxb-secret", transport);
    expect(result.principal).toBe("bot");
    expect(result.team).toBe("Acme");
    expect(result.teamId).toBe("T1");
    expect(result.user).toBe("suasor-bot");
    expect(result.scopes).toBe("channels:history,users:read");
    expect(tokens).toEqual(["xoxb-secret"]);
  });

  test("a user token (no bot_id) resolves principal=user", async () => {
    const { transport } = fakeAuth(
      { ok: true, team: "Acme", team_id: "T1", user: "ozzy", user_id: "U2" },
      "search:read",
    );
    const result = await testToken("xoxp-secret", transport);
    expect(result.principal).toBe("user");
  });

  test("a missing scopes header yields an empty scopes string", async () => {
    const { transport } = fakeAuth({ ok: true, team: "Acme", team_id: "T1" }, null);
    const result = await testToken("xoxb-secret", transport);
    expect(result.scopes).toBe("");
  });

  test("ok:false throws with the Slack error code, never the token", async () => {
    const { transport } = fakeAuth({ ok: false, error: "invalid_auth" }, null);
    const promise = testToken("xoxb-super-secret", transport);
    await expect(promise).rejects.toThrow(/invalid_auth/);
    await expect(promise).rejects.not.toThrow(/xoxb-super-secret/);
  });
});
