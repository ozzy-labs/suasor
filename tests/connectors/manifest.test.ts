/**
 * Connector manifest completeness (Issue #440, extending the registry-driven
 * completeness pattern of #162 / #296).
 *
 * Per-connector platform knowledge used to live in ~8 hand-maintained, name-keyed
 * tables in different files, with nothing enforcing that a connector appeared in
 * every table it needed — so forgetting one shipped silent per-surface gaps that
 * no compiler error or test caught (Issue #298 shipped exactly this). These tests
 * iterate `connectorNames()` and assert that every registered connector's
 * manifest is present and agrees with every real surface — the registry secret /
 * binary tables, the config-schema registry, `AUTH_SPECS` / `DISCOVERY_SPECS`,
 * the channel / team meta tables — or explicitly opts out with a documented
 * reason (`capabilityNotes`). A 10th connector that forgets a surface now fails
 * here instead of silently degrading in production.
 *
 * They also lock in the **central credential enforcement**: every credentialed
 * connector throws on a missing credential regardless of scope, driven by the
 * connector's declared `credentials` and enforced once in the sync service — the
 * invariant that used to be a guard copy-pasted into every connector's `sync()`.
 */
import { describe, expect, test } from "bun:test";
import { authConnectorNames } from "../../src/connectors/auth-specs.ts";
import { channelMetaConnectors } from "../../src/connectors/channel.ts";
import { discoveryConnectorNames } from "../../src/connectors/discovery-specs.ts";
import { connectorManifest, manifestConnectorNames } from "../../src/connectors/manifest.ts";
import {
  connectorBundledInBinary,
  connectorNames,
  connectorSecretNames,
  hasConnectorConfigSchema,
  loadConnector,
} from "../../src/connectors/registry.ts";
import { syncConnector } from "../../src/connectors/sync.ts";
import { teamMetaConnectors } from "../../src/connectors/team.ts";
import { Store } from "../../src/db/index.ts";

/** A secret store that resolves nothing (no env override, empty keychain). */
const NO_SECRETS = { env: {}, keychain: { get: () => null, set: () => {} } };

describe("connector manifest — registry parity", () => {
  test("every registered connector has a manifest and vice versa", () => {
    expect(manifestConnectorNames()).toEqual(connectorNames());
  });
});

describe("connector manifest — completeness (parametrized over connectorNames())", () => {
  for (const name of connectorNames()) {
    describe(name, () => {
      const manifest = connectorManifest(name);

      test("manifest exists and self-identifies", () => {
        expect(manifest).not.toBeNull();
        expect(manifest?.name).toBe(name);
      });

      test("sourceType matches the built connector", async () => {
        const connector = await loadConnector(name, {});
        expect(manifest?.sourceType).toBe(connector.sourceType);
      });

      test("secretNames matches the registry introspection table", () => {
        expect(manifest?.secretNames).toEqual(connectorSecretNames(name));
      });

      test("needsAuth ⟺ secretNames non-empty ⟺ Connector.credentials present", async () => {
        const hasSecrets = (manifest?.secretNames.length ?? 0) > 0;
        expect(manifest?.needsAuth).toBe(hasSecrets);
        const connector = await loadConnector(name, {});
        expect(connector.credentials != null).toBe(manifest?.needsAuth === true);
        if (connector.credentials) {
          expect(connector.credentials.secretNames.length).toBeGreaterThan(0);
          expect(connector.credentials.missingMessage.length).toBeGreaterThan(0);
        }
      });

      test("bundledInBinary matches the registry binary table", () => {
        expect(manifest?.bundledInBinary).toBe(connectorBundledInBinary(name));
      });

      test("configSchema is present, parses an empty slice, and is registered", () => {
        expect(hasConnectorConfigSchema(name)).toBe(true);
        expect(() => manifest?.configSchema.parse({})).not.toThrow();
      });

      test("noopWarning predicate is null or a non-throwing function", () => {
        const detect = manifest?.noopWarning;
        expect(detect === null || typeof detect === "function").toBe(true);
        if (typeof detect === "function") expect(() => detect({})).not.toThrow();
      });

      test("genericAuth ⟺ AUTH_SPECS entry, with a documented opt-out otherwise", () => {
        expect(manifest?.genericAuth).toBe(authConnectorNames().includes(name));
        // A credentialed connector that skips the generic auth verbs must say why
        // (e.g. Slack's own flow) so the opt-out is intentional, not a forgotten
        // AUTH_SPECS entry.
        if (manifest?.needsAuth && !manifest.genericAuth) {
          expect(manifest.capabilityNotes?.genericAuth?.length ?? 0).toBeGreaterThan(0);
        }
      });

      test("connectorSpecificOnboard ⟺ a registered onboard bridge (#458)", async () => {
        const { onboardBridgeNames } = await import("../../src/cli/onboard/bridges.ts");
        expect(manifest?.connectorSpecificOnboard ?? false).toBe(
          onboardBridgeNames().includes(name),
        );
      });

      test("genericDiscovery ⟺ DISCOVERY_SPECS entry, with a documented opt-out otherwise", () => {
        expect(manifest?.genericDiscovery).toBe(discoveryConnectorNames().includes(name));
        if (manifest?.needsAuth && !manifest.genericDiscovery) {
          expect(manifest.capabilityNotes?.genericDiscovery?.length ?? 0).toBeGreaterThan(0);
        }
      });

      test("surfacesChannels / surfacesTeams match the channel / team meta tables", () => {
        expect(manifest?.surfacesChannels).toBe(channelMetaConnectors().includes(name));
        expect(manifest?.surfacesTeams).toBe(teamMetaConnectors().includes(name));
      });
    });
  }
});

describe("connector manifest — central credential enforcement (ADR-0007, #440)", () => {
  for (const name of connectorNames()) {
    const manifest = connectorManifest(name);
    if (!manifest?.needsAuth) {
      test(`${name}: needs no credential — sync runs without a credential throw`, async () => {
        const store = Store.open({ path: ":memory:" });
        const connector = await loadConnector(name, {});
        expect(connector.credentials).toBeUndefined();
        // Empty scope + no credential is a clean no-op for the credential-free
        // connectors (web / local).
        await expect(
          syncConnector(store, connector, { secrets: NO_SECRETS }),
        ).resolves.toBeDefined();
      });
      continue;
    }

    test(`${name}: throws on a missing credential even with an empty scope`, async () => {
      const store = Store.open({ path: ":memory:" });
      // Built from an empty config slice: the ingest scope is empty, so the ONLY
      // reason to fail is the missing credential (the invariant #385/#404 hard-
      // rolled per connector, now enforced centrally by the sync service).
      const connector = await loadConnector(name, {});
      const message = connector.credentials?.missingMessage ?? "";
      await expect(syncConnector(store, connector, { secrets: NO_SECRETS })).rejects.toThrow(
        message,
      );
    });
  }
});
