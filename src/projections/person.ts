/**
 * Person identity helpers (ADR-0022).
 *
 * A connector author handle is keyed by `(connector, handle)`. The initial
 * resolution policy is **1 handle = 1 person**: the person id is a pure function
 * of that pair, so observing the same handle twice always targets the same
 * person (idempotent) and never resurrects a person an operator merged away.
 * Operators collapse duplicates explicitly via `person.merge` / `person.split`
 * (HITL, ADR-0004) — there is no automatic fuzzy de-duplication here.
 *
 * The hash is FNV-1a (32-bit) rendered as 8 lowercase hex chars, mirroring
 * src/propose/id.ts — small, stable, dependency-free, sufficient for a single
 * user's local identity set (not a security primitive). Fields join with a unit
 * separator (U+001F) that cannot occur in a handle, so boundaries never collide.
 */

/** Field separator for fingerprints (unit separator; never appears in content). */
const SEP = "\x1f";

/** FNV-1a 32-bit hash of a string -> 8 lowercase hex chars. */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * Stable key for one identity: `<connector>:<handle>`. One identity = one row in
 * the `person_identities` projection. The raw form is human-legible in listings
 * and unique because a connector name never contains `:` boundaries that would
 * collide a different `(connector, handle)` pair (handles may contain `:`, but
 * the connector prefix disambiguates within a connector's namespace).
 */
export function identityKey(connector: string, handle: string): string {
  return `${connector}:${handle}`;
}

/**
 * Content-derived person id for a `(connector, handle)` pair (1 handle = 1
 * person, ADR-0022). Pure function of the pair so re-observation is idempotent.
 * The `person_` prefix keeps the id self-describing in the projection.
 */
export function personIdFor(connector: string, handle: string): string {
  return `person_${fnv1a([connector, handle].join(SEP))}`;
}
