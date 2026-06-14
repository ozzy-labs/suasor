/** Projections module: reducers + replay-based rebuild (ADR-0002). */

export { type RebuildResult, rebuildProjections, truncateProjections } from "./rebuild.ts";
export { applyEvent, applyEvents } from "./reducer.ts";
