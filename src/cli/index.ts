/**
 * CLI entry (clipanion). Commands are registered eagerly but their heavy work
 * is lazy-imported inside `execute` to keep cold start light (NFR-PRF-1).
 *
 * Wired command surface (docs/design/cli.md):
 *   init · onboard · db migrate · projections rebuild · search · source list/forget ·
 *   <connector> sync · sync · sync status ·
 *   <connector> auth set/test (github/ms-graph/google/box) ·
 *   <connector> discovery verbs (github repos; ADR-0030) · connectors list ·
 *   config show · config edit · config validate (alias: validate-config) ·
 *   export backup ·
 *   embeddings status/rebuild/drain/find-duplicates · mcp serve · mcp tools ·
 *   slack auth set/test · slack conversations · slack status · slack cursor reset ·
 *   skills install/list/search/info
 * `init` / `db migrate` / `projections rebuild` / `search` / `<connector> sync` /
 * `mcp serve` (MCP read surface, ADR-0004) and `skills install` / `skills list`
 * (assistant-skill catalog, ADR-0008) are live. `<connector> sync` commands are
 * derived from the connector registry (one per connector, e.g. `github sync`;
 * ADR-0007).
 *
 * Registration is the only eager step. Command modules must keep their imports
 * to clipanion + the standard library so the registry stays cheap to build —
 * the DB layer, config loader, retrieval service, and connectors are imported
 * inside `execute`.
 */
import { Builtins, Cli, type CommandClass } from "clipanion";
import { VERSION } from "../version.ts";
import { BriefCommand } from "./commands/brief.ts";
import { ConfigEditCommand } from "./commands/config-edit.ts";
import { ConfigShowCommand } from "./commands/config-show.ts";
import { connectorAuthCommands } from "./commands/connector-auth.ts";
import { connectorDiscoveryCommands } from "./commands/connector-discovery.ts";
import { connectorSyncCommands } from "./commands/connector-sync.ts";
import { ConnectorsListCommand } from "./commands/connectors-list.ts";
import { DbMigrateCommand } from "./commands/db-migrate.ts";
import { DigestCommand } from "./commands/digest.ts";
import { DoctorCommand } from "./commands/doctor.ts";
import { embeddingsCommands } from "./commands/embeddings.ts";
import { ExportBackupCommand } from "./commands/export-backup.ts";
import {
  ExtractionListPendingCommand,
  ExtractionServeCommand,
  ExtractionStatusCommand,
} from "./commands/extraction.ts";
import { InitCommand } from "./commands/init.ts";
import { McpServeCommand } from "./commands/mcp-serve.ts";
import { McpToolsCommand } from "./commands/mcp-tools.ts";
import { OnboardCommand } from "./commands/onboard.ts";
import { ProjectionsRebuildCommand } from "./commands/projections-rebuild.ts";
import { SearchCommand } from "./commands/search.ts";
import {
  SkillsInfoCommand,
  SkillsInstallCommand,
  SkillsListCommand,
  SkillsPruneCommand,
  SkillsSearchCommand,
} from "./commands/skills.ts";
import {
  SlackAuthSetCommand,
  SlackAuthTestCommand,
  SlackConversationsCommand,
  SlackCursorBackfillCommand,
  SlackCursorResetCommand,
  SlackResolveNamesCommand,
  SlackStatusCommand,
} from "./commands/slack.ts";
import { SlackFollowCommand, SlackUnfollowCommand } from "./commands/slack-follow.ts";
import {
  SourceForgetCommand,
  SourceListCommand,
  SourceUnforgetCommand,
} from "./commands/source.ts";
import { StoreInfoCommand } from "./commands/store-info.ts";
import { StoreRetentionCommand } from "./commands/store-retention.ts";
import { SyncAllCommand, SyncStatusCommand } from "./commands/sync-all.ts";
import { ValidateConfigCommand } from "./commands/validate-config.ts";

/**
 * The full, ordered set of command classes the CLI registers. Kept as a single
 * list so the same registry drives both `buildCli()` (registration) and the
 * `categoryHelp()` interceptor (subcommand discovery) — the interceptor never
 * hand-maintains a verb list, so it cannot drift from what is actually wired.
 */
export function registeredCommandClasses(): CommandClass[] {
  return [
    Builtins.HelpCommand,
    Builtins.VersionCommand,
    InitCommand,
    OnboardCommand,
    DbMigrateCommand,
    ProjectionsRebuildCommand,
    SearchCommand,
    SourceListCommand,
    SourceForgetCommand,
    SourceUnforgetCommand,
    BriefCommand,
    DigestCommand,
    ...(connectorSyncCommands() as CommandClass[]),
    SyncAllCommand,
    SyncStatusCommand,
    ...(connectorAuthCommands() as CommandClass[]),
    ...(connectorDiscoveryCommands() as CommandClass[]),
    ConnectorsListCommand,
    ConfigShowCommand,
    ConfigEditCommand,
    ValidateConfigCommand,
    DoctorCommand,
    StoreInfoCommand,
    StoreRetentionCommand,
    ExportBackupCommand,
    ExtractionStatusCommand,
    ExtractionListPendingCommand,
    ExtractionServeCommand,
    ...(embeddingsCommands as CommandClass[]),
    McpServeCommand,
    McpToolsCommand,
    SlackAuthSetCommand,
    SlackAuthTestCommand,
    SlackConversationsCommand,
    SlackFollowCommand,
    SlackUnfollowCommand,
    SlackStatusCommand,
    SlackCursorResetCommand,
    SlackCursorBackfillCommand,
    SlackResolveNamesCommand,
    SkillsInstallCommand,
    SkillsListCommand,
    SkillsPruneCommand,
    SkillsSearchCommand,
    SkillsInfoCommand,
  ] as CommandClass[];
}

/** Build the configured CLI instance. */
export function buildCli(commands: CommandClass[] = registeredCommandClasses()): Cli {
  const cli = new Cli({
    binaryLabel: "Suasor",
    binaryName: "suasor",
    binaryVersion: VERSION,
  });
  for (const command of commands) {
    cli.register(command);
  }
  return cli;
}

const HELP_FLAGS = new Set(["-h", "--help"]);

/**
 * The category every new install needs first. clipanion renders general-help
 * categories strictly alphabetically (`Cli#usage` sorts category names with
 * `localeCompare`; there is no ordering hook), which buried Setup — the
 * init/onboard chain — ~170 lines below the connector plumbing (#566). The
 * root-help interceptor below hoists this category to the top.
 */
const SETUP_CATEGORY = "Setup";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/** Sentinel that opens clipanion's fixed general-help epilogue paragraph. */
const HELP_EPILOGUE_PREFIX = "You can also print more details";

/**
 * If `line` is a general-help category header, return the category name,
 * else `null`. Handles both of clipanion's header renderings: the colored
 * `━━━ Name ━━━…` rule (or `━━━ Name:` when the line is too long) and the
 * plain-text form, which is the bare category name on an unindented line.
 * Only names actually present in `categories` are accepted, so command or
 * description lines (always indented) and the binary banner never match.
 */
function headerCategory(line: string, categories: ReadonlySet<string>): string | null {
  if (line.startsWith(" ") || line.startsWith("\t")) return null;
  let stripped = line.replace(ANSI_PATTERN, "").trim();
  if (stripped.startsWith("━")) {
    stripped = stripped
      .replace(/^━+\s*/, "")
      .replace(/\s*━+$/, "")
      .replace(/:$/, "")
      .trim();
  }
  return categories.has(stripped) ? stripped : null;
}

/**
 * Reorder clipanion's rendered general help so the `Setup` category comes
 * first (right after the binary banner), leaving every other category in
 * clipanion's alphabetical order and all block contents byte-identical.
 *
 * Works on the rendered text because clipanion's category order is not
 * configurable (see `SETUP_CATEGORY`); the `categoryHelp()` interceptor above
 * is precedent for post-processing its rendering. The category-name set is
 * derived from the registry, so the parser cannot drift from what is wired.
 * Colored and plain renderings are both handled. If `Setup` is absent or
 * already first, the text is returned unchanged.
 */
export function setupFirstHelp(text: string, commands: CommandClass[]): string {
  const categories = new Set<string>(["General commands"]);
  for (const command of commands) {
    const category = command.usage?.category;
    if (category) categories.add(category.replace(/\s+/g, " ").trim());
  }

  // Partition into the preamble (binary banner) plus one block per category
  // header. Each block carries its trailing blank separator line, so blocks
  // can be reordered without disturbing spacing.
  const blocks: { name: string | null; lines: string[] }[] = [{ name: null, lines: [] }];
  for (const line of text.split("\n")) {
    const name = headerCategory(line, categories);
    if (name !== null) blocks.push({ name, lines: [] });
    (blocks[blocks.length - 1] as { lines: string[] }).lines.push(line);
  }

  // Detach the fixed epilogue paragraph from the last category block so a
  // reorder can never drag it away from the bottom of the help output.
  const last = blocks[blocks.length - 1] as { name: string | null; lines: string[] };
  const epilogueAt = last.lines.findIndex((line) =>
    line.replace(ANSI_PATTERN, "").startsWith(HELP_EPILOGUE_PREFIX),
  );
  if (epilogueAt > 0) {
    blocks.push({ name: null, lines: last.lines.splice(epilogueAt) });
  }

  const setupIndex = blocks.findIndex((block) => block.name === SETUP_CATEGORY);
  if (setupIndex <= 1) return text; // absent, or already the first category
  const [setup] = blocks.splice(setupIndex, 1);
  blocks.splice(1, 0, setup as { name: string | null; lines: string[] });
  return blocks.flatMap((block) => block.lines).join("\n");
}

/**
 * `true` for exactly the invocations clipanion answers with the general help:
 * a bare `suasor` and a root `suasor --help` / `-h`.
 */
export function isRootHelp(argv: string[]): boolean {
  if (argv.length === 0) return true;
  return argv.length === 1 && HELP_FLAGS.has(argv[0] as string);
}

/**
 * Pre-parse interceptor for `suasor <category-verb> --help`.
 *
 * clipanion resolves a partial path like `slack` — the common prefix of several
 * commands — as an *ambiguous* selection and renders a "Multiple commands match
 * your selection" list with `-h=<index>` follow-up hints. That rendering lives
 * in clipanion's internal HelpCommand and is not reachable through the public
 * builder (see the #395 spike), and it reads as an error to anyone exploring
 * the CLI (e.g. the primary `slack` verb group).
 *
 * This interceptor recognises exactly that shape — a bare `--help`/`-h` whose
 * remaining tokens form a path *prefix* shared by 2+ registered commands yet is
 * not itself a complete command — and returns a plain, readable subcommand
 * listing instead. Every other shape is left for clipanion so its behaviour is
 * unchanged: the root `--help` (general help), a complete command's `--help`
 * (detailed help), and any invocation carrying other options all return `null`.
 *
 * The subcommand set is derived from the registry (static `paths` +
 * `usage.description`), never hand-maintained. The `#0` positional placeholder
 * called out in #395 is a separate clipanion-core limitation and is out of
 * scope here (this listing shows commands + summaries, not option usage).
 *
 * @returns the text to print (the caller then exits 0), or `null` to defer to
 * clipanion's own resolution.
 */
export function categoryHelp(
  argv: string[],
  commands: CommandClass[],
  binaryName: string,
): string | null {
  // Only a bare category `--help`: exactly one help flag and no other options.
  const helpFlags = argv.filter((token) => HELP_FLAGS.has(token));
  if (helpFlags.length !== 1) return null;
  const prefix: string[] = [];
  for (const token of argv) {
    if (HELP_FLAGS.has(token)) continue;
    // Any other option means this is a real command invocation → defer.
    if (token.startsWith("-")) return null;
    prefix.push(token);
  }
  // Root `--help` (no verb) stays clipanion's general help.
  if (prefix.length === 0) return null;

  const matchesPrefix = (segments: string[]): boolean =>
    segments.length > prefix.length && prefix.every((seg, i) => segments[i] === seg);
  const equalsPrefix = (segments: string[]): boolean =>
    segments.length === prefix.length && prefix.every((seg, i) => segments[i] === seg);

  const subcommands: { segments: string[]; description?: string }[] = [];
  for (const command of commands) {
    const description = command.usage?.description;
    for (const segments of command.paths ?? []) {
      // A complete command's own `--help` is clipanion's detailed help → defer.
      if (equalsPrefix(segments)) return null;
      if (matchesPrefix(segments)) subcommands.push({ segments, description });
    }
  }

  // Only intercept the genuinely ambiguous case: a prefix shared by ≥2 commands.
  // A single deeper command resolves uniquely and needs no interception.
  if (subcommands.length < 2) return null;

  return renderCategoryHelp(prefix, subcommands, binaryName);
}

/** Levenshtein edit distance between two short command tokens. */
function editDistance(a: string, b: string): number {
  const prev: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = prev[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(above + 1, (prev[j - 1] as number) + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return prev[b.length] as number;
}

/** How many "did you mean" candidates an unknown command shows at most. */
const UNKNOWN_SUGGESTIONS = 3;

/**
 * Pre-parse interceptor for an unknown top-level command token (Issue #572).
 *
 * clipanion answers an unknown command with its "did you mean one of:" list of
 * *every* registered command — ~75 lines that bury the one the user mistyped.
 * That rendering lives in clipanion's internal error path and is not reachable
 * through the public builder (same limitation as `categoryHelp()` above, the
 * #395 precedent), so the unknown token is recognised before clipanion parses.
 *
 * Fires only when the first token is not an option (no leading `-`) and does
 * not open any registered command path — every valid invocation, option-first
 * invocation, and the bare root help are left for clipanion untouched. Prints
 * the closest {@link UNKNOWN_SUGGESTIONS} first tokens by edit distance
 * (bounded, so `suasor zzz` gets no absurd guesses), derived from the registry
 * so the candidate set cannot drift from what is wired.
 *
 * @returns the error text to print on stderr (the caller then exits 1), or
 * `null` to defer to clipanion's own resolution.
 */
export function unknownCommandHelp(
  argv: string[],
  commands: CommandClass[],
  binaryName: string,
): string | null {
  const first = argv[0];
  if (first === undefined || first.startsWith("-")) return null;

  const known = new Set<string>();
  for (const command of commands) {
    for (const segments of command.paths ?? []) {
      const head = segments[0];
      if (head !== undefined && !head.startsWith("-")) known.add(head);
    }
  }
  if (known.has(first)) return null;

  // Suggest only plausible typos: distance capped at 3 and at half the typed
  // token's length (so short garbage never "matches" a real verb).
  const threshold = Math.min(3, Math.max(1, Math.floor(first.length / 2)));
  const ranked = [...known]
    .map((token) => ({ token, distance: editDistance(first, token) }))
    .filter(({ distance }) => distance <= threshold)
    .sort((a, b) => a.distance - b.distance || a.token.localeCompare(b.token))
    .slice(0, UNKNOWN_SUGGESTIONS);

  const lines = [`error: unknown command '${first}'`];
  if (ranked.length > 0) {
    lines.push("", "Did you mean:", ...ranked.map(({ token }) => `  ${binaryName} ${token}`));
  }
  lines.push("", `Run \`${binaryName} --help\` for the full command list.`, "");
  return lines.join("\n");
}

/** Render the readable subcommand listing for a verb prefix. */
function renderCategoryHelp(
  prefix: string[],
  subcommands: { segments: string[]; description?: string }[],
  binaryName: string,
): string {
  const seen = new Set<string>();
  const rows: { command: string; description: string }[] = [];
  for (const { segments, description } of subcommands) {
    const command = [binaryName, ...segments].join(" ");
    if (seen.has(command)) continue;
    seen.add(command);
    rows.push({ command, description: (description ?? "").replace(/\s+/g, " ").trim() });
  }
  rows.sort((a, b) => a.command.localeCompare(b.command));

  const width = Math.max(...rows.map((row) => row.command.length));
  const verb = prefix.join(" ");
  const lines = [`Subcommands for \`${binaryName} ${verb}\`:`, ""];
  for (const { command, description } of rows) {
    lines.push(description ? `  ${command.padEnd(width)}  — ${description}` : `  ${command}`);
  }
  lines.push("");
  lines.push(
    `Run \`${binaryName} ${verb} <subcommand> --help\` for the details of a specific command.`,
  );
  lines.push("");
  return lines.join("\n");
}

/** Run the CLI against the given argv (defaults to process args). */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<number> {
  const commands = registeredCommandClasses();
  const help = categoryHelp(argv, commands, "suasor");
  if (help !== null) {
    process.stdout.write(help);
    return 0;
  }
  const unknown = unknownCommandHelp(argv, commands, "suasor");
  if (unknown !== null) {
    process.stderr.write(unknown);
    return 1;
  }
  const cli = buildCli(commands);
  if (isRootHelp(argv)) {
    // Root general help: render clipanion's own output (bare `usage()` keeps
    // its default color resolution), then hoist Setup to the top (#566).
    process.stdout.write(setupFirstHelp(cli.usage(), commands));
    return 0;
  }
  return cli.run(argv, Cli.defaultContext);
}
