import { describe, expect, test } from "bun:test";
import { FEATURE_SCOPES } from "../../../src/connectors/slack/scopes.ts";

/**
 * Drift guard: the shipped Slack App manifest (docs/guide/slack-app-manifest.yaml)
 * must request exactly the OAuth scopes the SSOT (FEATURE_SCOPES in
 * src/connectors/slack/scopes.ts) declares — no more, no less. Split by token
 * principal: User-Token-only features go in `oauth_config.scopes.user`, the rest
 * in `oauth_config.scopes.bot`. If scopes.ts gains a feature/scope, this test
 * fails until the manifest is updated, so the two never silently diverge.
 */

const MANIFEST_PATH = new URL("../../../docs/guide/slack-app-manifest.yaml", import.meta.url);

interface Manifest {
  oauth_config?: {
    scopes?: {
      bot?: string[];
      user?: string[];
    };
  };
}

/** Expected scopes, derived from the SSOT (required + recommended), split by principal. */
function expectedScopes(): { bot: Set<string>; user: Set<string> } {
  const bot = new Set<string>();
  const user = new Set<string>();
  for (const spec of Object.values(FEATURE_SCOPES)) {
    const target = spec.userTokenOnly ? user : bot;
    for (const scope of [...spec.required, ...spec.recommended]) target.add(scope);
  }
  return { bot, user };
}

async function loadManifest(): Promise<Manifest> {
  const text = await Bun.file(MANIFEST_PATH).text();
  return Bun.YAML.parse(text) as Manifest;
}

describe("slack app manifest — scope SSOT drift guard", () => {
  test("manifest bot scopes match the non-User-Token-only SSOT scopes exactly", async () => {
    const manifest = await loadManifest();
    const expected = expectedScopes();
    const bot = new Set(manifest.oauth_config?.scopes?.bot ?? []);
    expect([...bot].sort()).toEqual([...expected.bot].sort());
  });

  test("manifest user scopes match the User-Token-only SSOT scopes exactly", async () => {
    const manifest = await loadManifest();
    const expected = expectedScopes();
    const user = new Set(manifest.oauth_config?.scopes?.user ?? []);
    expect([...user].sort()).toEqual([...expected.user].sort());
  });

  test("no scope is requested for both principals (bot vs user are disjoint)", async () => {
    const manifest = await loadManifest();
    const bot = new Set(manifest.oauth_config?.scopes?.bot ?? []);
    const user = manifest.oauth_config?.scopes?.user ?? [];
    expect(user.filter((s) => bot.has(s))).toEqual([]);
  });
});
