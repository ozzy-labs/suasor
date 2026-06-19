/**
 * Connectors module: read-only ingest contract + sync service + registry
 * (ADR-0007, docs/design/connector-contract.md).
 *
 * Import-clean: re-exports types and the registry/service entry points only.
 * Connector SDKs (octokit, …) and the native keyring binding are loaded lazily
 * inside the connector / secret functions, never at module import time
 * (NFR-PRF-1).
 */
export type {
  Connector,
  ConnectorConfig,
  ConnectorFactory,
  SourceRecord,
  SyncContext,
  SyncResult,
} from "./contract.ts";
export {
  connectorNames,
  connectorSecretNames,
  hasConnector,
  loadConnector,
} from "./registry.ts";
export {
  KEYCHAIN_SERVICE,
  type KeychainBackend,
  keychainAccount,
  makeSecretResolver,
  resolveSecret,
  type SecretStoreOptions,
  secretEnvName,
  storeSecret,
} from "./secrets.ts";
export {
  lastCursor,
  type SyncOptions,
  type SyncOutcome,
  syncConnector,
} from "./sync.ts";
