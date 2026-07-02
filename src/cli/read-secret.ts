/**
 * Line-based secret entry for the interactive setup verbs (`onboard`,
 * `<connector> auth set`, `slack auth set`; Issue #383).
 *
 * The problem this replaces: the old helpers read stdin to **EOF**. On a real
 * TTY the user presses Enter but the wizard keeps waiting (a line does not close
 * the stream), so it hangs until Ctrl-D — and the typed token is echoed in
 * cleartext. This module reads a **single line** instead:
 *
 * - **TTY (raw mode)** — enable raw mode so keystrokes arrive one at a time,
 *   echo nothing (or a `*` mask per keystroke), and resolve on the first
 *   `\r` / `\n`. Ctrl-C aborts; Ctrl-D ends input. Raw mode is **always**
 *   restored — on submit, on abort, and on any thrown error.
 * - **non-TTY (pipe / test-injected async iterable)** — read up to and excluding
 *   the first newline; on EOF with no newline seen, return the accumulated
 *   buffer (backward-compatible with a trailing-newline-free `printf 'tok' |`
 *   pipe — the same rule as the connector-selection `readLine`).
 *
 * Import-clean (NFR-PRF-1): only Node's `Buffer` is used; no SDK / native addon
 * is pulled, so command modules can import this at top level and keep cold start
 * light. Raw mode is engaged **only** when stdin is a TTY that exposes
 * `setRawMode`, so a piped / injected stream never touches terminal state.
 */

/** Options for {@link readSecretLine}. */
export interface ReadSecretOptions {
  /**
   * Echo a `*` per typed character on a TTY (default: echo nothing). The mask
   * gives keystroke feedback without leaving the token in the scrollback; it is
   * ignored on the non-TTY path (a pipe never echoes).
   */
  mask?: boolean;
}

/** Minimal stderr surface used for the TTY mask echo. */
interface Writable {
  write(chunk: string): unknown;
}

/**
 * The outcome of folding one chunk of raw-mode keystrokes into the current line
 * buffer. Extracted as a pure value so the keystroke→buffer transitions are
 * unit-testable without a real TTY (Issue #383).
 */
export type RawKeyOutcome =
  /** No terminator yet: keep reading. `echo` is what to write to the terminal. */
  | { readonly kind: "continue"; readonly buffer: string; readonly echo: string }
  /** A CR/LF was seen: the line is complete. `echo` covers chars before it. */
  | { readonly kind: "submit"; readonly buffer: string; readonly echo: string }
  /** Ctrl-C (ETX): the user aborted entry. */
  | { readonly kind: "abort" }
  /** Ctrl-D (EOT): end of input; resolve with whatever is buffered. */
  | { readonly kind: "eof"; readonly buffer: string };

const CTRL_C = 0x03;
const CTRL_D = 0x04;
const BACKSPACE = 0x08;
const ESC = 0x1b;
const DEL = 0x7f;

/**
 * Pure raw-mode line editor step: fold `chunk` into `buffer`, returning the next
 * buffer, what to echo, and whether the line is complete. Handles CR/LF
 * (submit), Ctrl-C (abort), Ctrl-D (eof), Backspace/DEL (delete the last char),
 * and drops other control bytes — including an ESC-introduced escape sequence
 * (arrow keys etc.), which is discarded to the end of the chunk rather than
 * inserted as literal `[A` garbage.
 */
export function editRawSecret(
  buffer: string,
  chunk: string,
  options: ReadSecretOptions = {},
): RawKeyOutcome {
  const mask = options.mask ?? false;
  let buf = buffer;
  let echo = "";
  for (const ch of chunk) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\n" || ch === "\r") return { kind: "submit", buffer: buf, echo };
    if (code === CTRL_C) return { kind: "abort" };
    if (code === CTRL_D) return { kind: "eof", buffer: buf };
    if (code === BACKSPACE || code === DEL) {
      if (buf.length > 0) {
        buf = buf.slice(0, -1);
        // Erase the last mask glyph: backspace, overwrite with a space, back.
        if (mask) echo += "\b \b";
      }
      continue;
    }
    // ESC starts a terminal escape sequence (arrows / function keys). Its bytes
    // are printable ASCII after ESC, so drop the remainder of this chunk rather
    // than inserting them; a sequence is delivered as its own chunk in practice.
    if (code === ESC) break;
    if (code < 0x20) continue; // other C0 controls: ignore
    buf += ch;
    if (mask) echo += "*";
  }
  return { kind: "continue", buffer: buf, echo };
}

/**
 * Whether stdin should be treated as interactive (a TTY), so a prompt is worth
 * showing. Mirrors the check the wizard uses; a pipe / CI / injected stream is
 * non-interactive.
 */
export function isInteractiveStdin(stdin: unknown): boolean {
  return Boolean((stdin as { isTTY?: boolean } | undefined)?.isTTY);
}

/** A TTY stdin that exposes the raw-mode + event surface we drive char-by-char. */
interface RawTTY {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
}

/** Whether stdin is a raw-capable TTY (so we read a line char-by-char, no echo). */
function isRawCapableTTY(stdin: unknown): stdin is RawTTY {
  const s = stdin as { isTTY?: boolean; setRawMode?: unknown } | undefined;
  return Boolean(s?.isTTY) && typeof s?.setRawMode === "function";
}

/**
 * Read one secret line from stdin without leaving it in the terminal scrollback.
 * Chooses the raw-mode TTY path or the line-buffered stream path automatically.
 * The returned string excludes the terminating newline; callers `.trim()` it.
 */
export function readSecretLine(
  stdin: unknown,
  stderr: Writable,
  options: ReadSecretOptions = {},
): Promise<string> {
  if (isRawCapableTTY(stdin)) {
    return readSecretLineFromTTY(stdin, stderr, options);
  }
  return readSecretLineFromStream(stdin as AsyncIterable<Buffer | string>);
}

/**
 * Line-buffered read for a pipe / injected async iterable. Returns as soon as the
 * first newline arrives — crucially **without** waiting for the stream to close
 * (the old read-to-EOF helper hung on a TTY / an open pipe). On EOF with no
 * newline, the accumulated buffer is returned (trailing-newline-free pipe compat).
 */
async function readSecretLineFromStream(stdin: AsyncIterable<Buffer | string>): Promise<string> {
  let buffer = "";
  for await (const chunk of stdin) {
    buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : (chunk as string);
    const newline = buffer.indexOf("\n");
    if (newline >= 0) {
      // Strip a trailing CR so a Windows `\r\n` pipe yields the bare token.
      const line = buffer.slice(0, newline);
      return line.endsWith("\r") ? line.slice(0, -1) : line;
    }
  }
  return buffer;
}

/**
 * Raw-mode TTY read: keystrokes one at a time, no cleartext echo, resolve on
 * Enter. Raw mode is restored in every exit path (submit / eof / abort / error).
 * On Ctrl-C the terminal is restored and SIGINT is re-raised so the command
 * aborts with the conventional Ctrl-C semantics (no partial token stored).
 */
function readSecretLineFromTTY(
  input: RawTTY,
  stderr: Writable,
  options: ReadSecretOptions,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const wasRaw = input.isRaw === true;

    const restore = (): void => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      try {
        input.setRawMode(wasRaw);
      } catch {
        // Best-effort restore; nothing actionable if the tty is already gone.
      }
      input.pause();
    };

    const onData = (chunk: Buffer): void => {
      const outcome = editRawSecret(buffer, chunk.toString("utf8"), options);
      if (outcome.kind === "continue") {
        buffer = outcome.buffer;
        if (outcome.echo) stderr.write(outcome.echo);
        return;
      }
      if (settled) return;
      settled = true;
      if (outcome.kind === "submit") {
        if (outcome.echo) stderr.write(outcome.echo);
        stderr.write("\n"); // Enter was not echoed in raw mode; move to a new line.
        restore();
        resolve(outcome.buffer);
      } else if (outcome.kind === "eof") {
        stderr.write("\n");
        restore();
        resolve(outcome.buffer);
      } else {
        // abort (Ctrl-C): restore the terminal, then re-raise SIGINT so the CLI
        // exits with Ctrl-C semantics rather than storing a half-typed token.
        stderr.write("\n");
        restore();
        process.kill(process.pid, "SIGINT");
        reject(new Error("secret entry aborted"));
      }
    };

    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      restore();
      reject(err);
    };

    try {
      input.setRawMode(true);
    } catch (err) {
      // If raw mode cannot be engaged, fall back to the line-buffered path so we
      // never leave the terminal in a half-configured state.
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    input.on("data", onData);
    input.on("error", onError);
    input.resume();
  });
}
