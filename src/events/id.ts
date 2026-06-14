/**
 * Lexicographically sortable, time-ordered event id (ULID-like).
 *
 * Format: 48-bit millisecond timestamp + 80 bits of randomness, Crockford
 * base32, 26 chars. Sortable by creation time and globally unique without a
 * runtime dependency. The store's `seq` column remains the authoritative replay
 * order; this id is the stable cross-system identifier.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(now: number, len: number): string {
  let mod: number;
  let out = "";
  let value = now;
  for (let i = len - 1; i >= 0; i--) {
    mod = value % 32;
    out = ENCODING[mod] + out;
    value = (value - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ENCODING[(bytes[i] as number) % 32];
  }
  return out;
}

/** Generate a new ULID-like event id. */
export function newEventId(now: number = Date.now()): string {
  return encodeTime(now, TIME_LEN) + encodeRandom(RANDOM_LEN);
}
