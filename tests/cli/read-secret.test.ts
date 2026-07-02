/**
 * `readSecretLine` / `editRawSecret` — line-based, echo-suppressed secret entry
 * (Issue #383). No TTY / no keychain: the non-TTY (pipe / injected iterable)
 * path is exercised directly, and the raw-mode keystroke handling is unit-tested
 * through the pure `editRawSecret` reducer (a real TTY is verified by hand — see
 * the PR's manual-check note).
 */
import { describe, expect, test } from "bun:test";
import { editRawSecret, isInteractiveStdin, readSecretLine } from "../../src/cli/read-secret.ts";

/** A stderr sink that records everything written (for the mask assertions). */
function recorder(): { write(s: string): boolean; text(): string } {
  let buf = "";
  return {
    write(s: string) {
      buf += s;
      return true;
    },
    text: () => buf,
  };
}

/** Reject if `p` does not settle within `ms` — turns a hang into a fast failure. */
function withTimeout<T>(p: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("readSecretLine hung (did not resolve)")), ms),
    ),
  ]);
}

/**
 * An async iterable that yields `chunk` once and then **never closes** (a
 * subsequent `next()` hangs forever). Models an open TTY / pipe: the regression
 * is that the old read-to-EOF helper hung here, while `readSecretLine` must
 * resolve as soon as the newline arrives — without waiting for the stream to end.
 */
function yieldThenHang(chunk: string): AsyncIterable<string> {
  let done = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (!done) {
            done = true;
            return Promise.resolve({ value: chunk, done: false });
          }
          return new Promise<IteratorResult<string>>(() => {}); // never settles
        },
        return: () => Promise.resolve({ value: undefined, done: true }),
      };
    },
  };
}

/**
 * A persistent async iterable: `[Symbol.asyncIterator]()` returns the *same*
 * iterator each call and its `return()` is a no-op, so a second `readSecretLine`
 * continues from where the first stopped (not-yet-read chunks are not consumed).
 */
function persistentIterable(chunks: string[]): AsyncIterable<string> {
  let i = 0;
  const iterator: AsyncIterator<string> = {
    next(): Promise<IteratorResult<string>> {
      if (i < chunks.length) return Promise.resolve({ value: chunks[i++] as string, done: false });
      return Promise.resolve({ value: undefined, done: true });
    },
    // No-op: does NOT reset `i`, so the remainder stays available for the next read.
    return: () => Promise.resolve({ value: undefined, done: true }),
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

describe("readSecretLine — non-TTY (pipe / injected iterable) path", () => {
  test("resolves on the first newline even when the stream never closes (regression)", async () => {
    // The read-to-EOF helper hung here (it waited for close); this must resolve
    // to the line as soon as the newline arrives.
    const value = await withTimeout(readSecretLine(yieldThenHang("tok\n"), recorder()));
    expect(value).toBe("tok");
  });

  test("returns the buffer on EOF with no trailing newline (pipe compat)", async () => {
    async function* stream() {
      yield "tok"; // `printf 'tok' | …` — no trailing newline, then EOF
    }
    expect(await readSecretLine(stream(), recorder())).toBe("tok");
  });

  test("consumes only the first line; the remainder stays for the next read", async () => {
    const stdin = persistentIterable(["line1\n", "line2\n"]);
    expect(await withTimeout(readSecretLine(stdin, recorder()))).toBe("line1");
    expect(await withTimeout(readSecretLine(stdin, recorder()))).toBe("line2");
  });

  test("strips a trailing CR so a Windows \\r\\n pipe yields the bare token", async () => {
    async function* stream() {
      yield "tok\r\n";
    }
    expect(await readSecretLine(stream(), recorder())).toBe("tok");
  });

  test("does not echo anything on the non-TTY path (no cleartext, no mask)", async () => {
    const err = recorder();
    async function* stream() {
      yield "secret\n";
    }
    await readSecretLine(stream(), err, { mask: true });
    expect(err.text()).toBe("");
  });
});

describe("editRawSecret — pure raw-mode line editor (no real TTY)", () => {
  test("accumulates printable chars without echoing when unmasked", () => {
    const out = editRawSecret("", "abc");
    expect(out).toEqual({ kind: "continue", buffer: "abc", echo: "" });
  });

  test("masks each printable char with a single '*' when mask is set", () => {
    const out = editRawSecret("", "abc", { mask: true });
    expect(out).toEqual({ kind: "continue", buffer: "abc", echo: "***" });
  });

  test("submits on \\n (Enter), carrying the mask echo for chars before it", () => {
    const out = editRawSecret("ab", "c\n", { mask: true });
    expect(out).toEqual({ kind: "submit", buffer: "abc", echo: "*" });
  });

  test("submits on \\r (carriage return) too", () => {
    expect(editRawSecret("tok", "\r")).toEqual({ kind: "submit", buffer: "tok", echo: "" });
  });

  test("Ctrl-C (ETX, 0x03) aborts", () => {
    expect(editRawSecret("half", "\x03")).toEqual({ kind: "abort" });
  });

  test("Ctrl-D (EOT, 0x04) ends input with the current buffer", () => {
    expect(editRawSecret("tok", "\x04")).toEqual({ kind: "eof", buffer: "tok" });
  });

  test("Backspace (0x08) deletes the last char; mask erases the last glyph", () => {
    expect(editRawSecret("abc", "\x08", { mask: true })).toEqual({
      kind: "continue",
      buffer: "ab",
      echo: "\b \b",
    });
  });

  test("DEL (0x7f) deletes the last char; no echo when unmasked", () => {
    expect(editRawSecret("abc", "\x7f")).toEqual({ kind: "continue", buffer: "ab", echo: "" });
  });

  test("Backspace on an empty buffer is a no-op", () => {
    expect(editRawSecret("", "\x7f", { mask: true })).toEqual({
      kind: "continue",
      buffer: "",
      echo: "",
    });
  });

  test("an ESC-introduced escape sequence (arrow key) does not corrupt the buffer", () => {
    // Up-arrow is ESC [ A; the printable [A must not be inserted as literal text.
    expect(editRawSecret("tok", "\x1b[A", { mask: true })).toEqual({
      kind: "continue",
      buffer: "tok",
      echo: "",
    });
  });
});

describe("isInteractiveStdin", () => {
  test("true for a TTY-flagged stream", () => {
    expect(isInteractiveStdin({ isTTY: true })).toBe(true);
  });

  test("false for a plain async iterable (pipe / injected)", () => {
    expect(isInteractiveStdin((async function* () {})())).toBe(false);
  });

  test("false for undefined", () => {
    expect(isInteractiveStdin(undefined)).toBe(false);
  });
});
