#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { runScan } from './commands/scan.ts';
import { runView } from './commands/view.ts';
import { runQuery } from './commands/query.ts';
import { runChanged } from './commands/changed.ts';
import { runCheck } from './commands/check.ts';
import { runDiff } from './commands/diff.ts';
import { runExport } from './commands/export.ts';
import { runMcp } from './commands/mcp.ts';
import { runOverview, runAgentsMd } from './commands/overview.ts';
import { GraphLoadError } from './graph/io.ts';
import { VERSION } from './version.ts';

// Exit codes: 0 ok · 1 runtime failure · 2 usage error · 3 bad scan path ·
// 4 nothing to scan · 5 graph or file not found · 6 unusable graph.json ·
// 7 a check budget is broken.

/** Bad flags or arguments: exit 2, unlike a failure while running (exit 1). */
class UsageError extends Error {
  /** The command whose --help the message points at. */
  command?: string;
}

type Values = Record<string, string | boolean | string[] | undefined>;

interface Command {
  usage: string;
  summary: string;
  flags: string;
  /** Extra lines for `nerve <command> --help`, after the flags. */
  notes?: string;
  options: NonNullable<ParseArgsConfig['options']>;
  run: (values: Values, positionals: string[]) => Promise<number>;
}

const str = (v: Values[string]) => (typeof v === 'string' ? v : undefined);
const bool = (v: Values[string]) => (v === true ? true : undefined);

/** A non-negative integer flag; anything else is a usage error, never NaN. */
function int(flag: string, v: Values[string], max = Number.MAX_SAFE_INTEGER): number | undefined {
  if (v === undefined) return undefined;
  const s = String(v);
  if (!/^\d+$/.test(s) || Number(s) > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? 'a non-negative whole number' : `a whole number from 0 to ${max}`;
    throw new UsageError(`--${flag} expects ${range}, got "${s}"`);
  }
  return Number(s);
}

const COMMANDS: Record<string, Command> = {
  scan: {
    usage: 'nerve scan   [path]  [flags]',
    summary: 'Scan project, write .nervegraph/graph.json',
    flags: `
  --profile <name>   shopify | js | poly | auto
  --out <dir>        default .nervegraph
  --ignore <glob>     repeatable
  --no-gitignore
  --no-git           skip git history (churn is not collected)
  --classes
  --pretty           indent graph.json (bigger, human-diffable)
  --json
  --quiet
  --watch            re-scan on change; an open viewer follows along`,
    options: {
      profile: { type: 'string' },
      out: { type: 'string' },
      ignore: { type: 'string', multiple: true },
      'no-gitignore': { type: 'boolean' },
      'no-git': { type: 'boolean' },
      classes: { type: 'boolean' },
      pretty: { type: 'boolean' },
      json: { type: 'boolean' },
      quiet: { type: 'boolean' },
      watch: { type: 'boolean' },
    },
    run: (v, positionals) => runScan({
      path: positionals[0],
      profile: str(v.profile),
      out: str(v.out),
      ignore: v.ignore as string[] | undefined,
      noGitignore: bool(v['no-gitignore']),
      noGit: bool(v['no-git']),
      classes: bool(v.classes),
      pretty: bool(v.pretty),
      json: bool(v.json),
      quiet: bool(v.quiet),
      watch: bool(v.watch),
    }),
  },

  view: {
    usage: 'nerve view           [flags]',
    summary: 'Serve an interactive map locally',
    flags: `
  --port <n>          default 4210 (0 picks any free port)
  --no-open
  --graph <path>       default .nervegraph/graph.json`,
    options: {
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      graph: { type: 'string' },
    },
    run: (v) => runView({
      port: int('port', v.port, 65535),
      noOpen: bool(v['no-open']),
      graph: str(v.graph),
    }),
  },

  query: {
    usage: 'nerve query  <file>  [flags]',
    summary: 'What uses this file, and what it uses',
    flags: `
  --json              machine-readable card, nothing else on stdout (one line)
  --pretty            indent the JSON
  --limit <n>         entries per list (default 50, 0 = all); the rest is counted under "truncated"
  --raw               include the source text of each reference
  --depth <n>         also list neighbours up to n hops away
  --direction <d>     in | out | both (default) — which way --depth walks
  --transitive        list every transitive dependent, not just the count
  --symbol <name>     where an export is defined and every import site naming it
  --changed           git changes, their dependents and the tests to run
  --base <ref>        with --changed: also include changes since this ref
  --orphans           list unreferenced code files (--all adds tests, docs, config, …)
  --all               with --orphans: every kind
  --fields <a,b>      list modes: keep only these row fields
  --missing           list referenced files that are not on disk
  --unresolved        list references static analysis could not follow
  --risk <level>      list files at low | medium | high risk
  --dead-exports      list exports nothing imports
  --packages          fold the graph up to one node per package
  --duplicates        list groups of byte-identical files
  --cycles            list dependency cycles
  --graph <path>       default .nervegraph/graph.json`,
    options: {
      json: { type: 'boolean' },
      pretty: { type: 'boolean' },
      limit: { type: 'string' },
      raw: { type: 'boolean' },
      depth: { type: 'string' },
      direction: { type: 'string' },
      transitive: { type: 'boolean' },
      symbol: { type: 'string' },
      changed: { type: 'boolean' },
      base: { type: 'string' },
      all: { type: 'boolean' },
      fields: { type: 'string' },
      orphans: { type: 'boolean' },
      missing: { type: 'boolean' },
      unresolved: { type: 'boolean' },
      risk: { type: 'string' },
      'dead-exports': { type: 'boolean' },
      packages: { type: 'boolean' },
      duplicates: { type: 'boolean' },
      cycles: { type: 'boolean' },
      graph: { type: 'string' },
    },
    run: (v, positionals) => {
      const risk = str(v.risk);
      if (risk !== undefined && !['low', 'medium', 'high'].includes(risk)) {
        throw new UsageError(`--risk expects low | medium | high, got "${risk}"`);
      }
      const direction = str(v.direction);
      if (direction !== undefined && !['in', 'out', 'both'].includes(direction)) {
        throw new UsageError(`--direction expects in | out | both, got "${direction}"`);
      }
      if (v.base !== undefined && !v.changed) throw new UsageError('--base only applies with --changed');
      if (v.changed) {
        return runChanged({ graph: str(v.graph), base: str(v.base), json: bool(v.json), pretty: bool(v.pretty), limit: int('limit', v.limit) });
      }
      return runQuery({
        file: positionals[0],
        json: bool(v.json),
        pretty: bool(v.pretty),
        limit: int('limit', v.limit),
        raw: bool(v.raw),
        depth: int('depth', v.depth),
        direction: direction as 'in' | 'out' | 'both' | undefined,
        transitive: bool(v.transitive),
        symbol: str(v.symbol),
        all: bool(v.all),
        fields: str(v.fields)?.split(',').map(f => f.trim()).filter(Boolean),
        orphans: bool(v.orphans),
        missing: bool(v.missing),
        unresolved: bool(v.unresolved),
        risk,
        deadExports: bool(v['dead-exports']),
        packages: bool(v.packages),
        duplicates: bool(v.duplicates),
        cycles: bool(v.cycles),
        graph: str(v.graph),
      });
    },
  },

  check: {
    usage: 'nerve check          [flags]',
    summary: 'Fail the build when the graph breaks a budget (exit code 7)',
    flags: `
  --max-cycles <n>
  --max-unresolved <n>
  --max-orphans <n>
  --allow-missing     tolerate references to files that are not on disk
  --no-dead-exports   fail if any export is unused
  --no-duplicates     fail if any two files are byte-identical
  --rules <file>      layer rules (default .nervegraph/rules.json when present)
  --json
  --graph <path>       default .nervegraph/graph.json`,
    options: {
      'max-cycles': { type: 'string' },
      'max-unresolved': { type: 'string' },
      'max-orphans': { type: 'string' },
      'allow-missing': { type: 'boolean' },
      'no-dead-exports': { type: 'boolean' },
      'no-duplicates': { type: 'boolean' },
      rules: { type: 'string' },
      json: { type: 'boolean' },
      graph: { type: 'string' },
    },
    run: (v) => runCheck({
      graph: str(v.graph),
      json: bool(v.json),
      maxCycles: int('max-cycles', v['max-cycles']),
      maxUnresolved: int('max-unresolved', v['max-unresolved']),
      maxOrphans: int('max-orphans', v['max-orphans']),
      allowMissing: bool(v['allow-missing']),
      noDeadExports: bool(v['no-dead-exports']),
      noDuplicates: bool(v['no-duplicates']),
      rules: str(v.rules),
    }),
  },

  diff: {
    usage: 'nerve diff [a] [b]   [flags]',
    summary: 'What changed structurally between two graphs',
    flags: `
  --json              machine-readable diff, nothing else on stdout`,
    notes: `
  No arguments: the previous scan (.nervegraph/graph.prev.json) against the current one.
  One argument: that graph against .nervegraph/graph.json.`,
    options: { json: { type: 'boolean' } },
    run: (v, positionals) => runDiff({ before: positionals[0], after: positionals[1], json: bool(v.json) }),
  },

  export: {
    usage: 'nerve export         [flags]',
    summary: 'The graph as mermaid or dot text',
    flags: `
  --format <name>     mermaid (default) | dot
  --focus <file>      only this file's neighbourhood (same lookup as query)
  --depth <n>         how far around --focus to reach (default 1)
  --out <file>        write there instead of stdout
  --graph <path>       default .nervegraph/graph.json`,
    options: {
      format: { type: 'string' },
      focus: { type: 'string' },
      depth: { type: 'string' },
      out: { type: 'string' },
      graph: { type: 'string' },
    },
    run: (v) => runExport({
      format: str(v.format),
      focus: str(v.focus),
      depth: int('depth', v.depth),
      out: str(v.out),
      graph: str(v.graph),
    }),
  },

  mcp: {
    usage: 'nerve mcp            [flags]',
    summary: 'Serve the graph to an agent over MCP (stdio)',
    flags: `
  --graph <path>       default .nervegraph/graph.json (re-read on every call)
  --no-autoscan       never re-scan; by default a missing or stale graph is re-scanned before a call`,
    notes: `
  Speaks JSON-RPC 2.0 on stdin/stdout; tools: nervegraph_overview, nervegraph_query,
  nervegraph_symbol, nervegraph_changed, nervegraph_list.
  Register it: { "command": "npx", "args": ["nervegraph", "mcp"] }`,
    options: { graph: { type: 'string' }, 'no-autoscan': { type: 'boolean' } },
    run: (v) => runMcp({ graph: str(v.graph), noAutoscan: bool(v['no-autoscan']) }),
  },

  overview: {
    usage: 'nerve overview       [flags]',
    summary: 'How the project is laid out, in one small answer',
    flags: `
  --json              machine-readable (one line, ~1 KB)
  --pretty            indent the JSON
  --graph <path>       default .nervegraph/graph.json`,
    options: { json: { type: 'boolean' }, pretty: { type: 'boolean' }, graph: { type: 'string' } },
    run: (v) => runOverview({ json: bool(v.json), pretty: bool(v.pretty), graph: str(v.graph) }),
  },

  'agents-md': {
    usage: 'nerve agents-md      [flags]',
    summary: 'A snippet for CLAUDE.md / AGENTS.md',
    flags: `
  --graph <path>       default .nervegraph/graph.json`,
    notes: `
  Append it: nerve agents-md >> CLAUDE.md`,
    options: { graph: { type: 'string' } },
    run: (v) => runAgentsMd({ graph: str(v.graph) }),
  },
};

const HELP = `nervegraph ${VERSION}

Usage:
${Object.values(COMMANDS).map(c => `  ${c.usage.padEnd(31)}${c.summary}`).join('\n')}

  nerve <command> --help     flags of one command
  nerve --version
${Object.entries(COMMANDS).map(([name, c]) => `\n${name} flags:${c.flags}`).join('\n')}
`;

function commandHelp(name: string): string {
  const c = COMMANDS[name];
  return `Usage: ${c.usage}\n\n  ${c.summary}\n\nflags:${c.flags}\n  -h, --help          show this help\n${c.notes ?? ''}`;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    const topic = command === 'help' ? rest[0] : undefined;
    console.log(topic && COMMANDS[topic] ? commandHelp(topic) : HELP);
    return 0;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(VERSION);
    return 0;
  }

  const cmd = COMMANDS[command];
  if (!cmd) {
    console.error(`error: unknown command "${command}"\n`);
    console.error(HELP);
    return 2;
  }

  try {
    let parsed: { values: Values; positionals: string[] };
    try {
      parsed = parseArgs({
        args: rest,
        options: { ...cmd.options, help: { type: 'boolean', short: 'h' } },
        allowPositionals: true,
        strict: true,
      }) as { values: Values; positionals: string[] };
    } catch (e: any) {
      // Unknown flag, missing flag value, ...: the caller's mistake, not ours.
      if (String(e?.code).startsWith('ERR_PARSE_ARGS')) throw new UsageError(e.message);
      throw e;
    }
    if (parsed.values.help) {
      console.log(commandHelp(command));
      return 0;
    }
    return await cmd.run(parsed.values, parsed.positionals);
  } catch (e) {
    if (e instanceof UsageError) e.command ??= command;
    throw e;
  }
}

main().then(
  // Exit only once stdout has drained: on an asynchronous pipe, exiting
  // straight away can cut a large `--json` document short.
  (code) => process.stdout.write('', () => process.exit(code)),
  (e) => {
    // Errors always go to stderr, so `--json` output on stdout stays pure.
    if (e instanceof UsageError) {
      console.error(`error: ${e.message}`);
      console.error(`run: nerve ${e.command ? `${e.command} ` : ''}--help`);
      process.exit(2);
    }
    if (e instanceof GraphLoadError) {
      console.error(`error: ${e.message}`);
      process.exit(e.exitCode);
    }
    if (process.env.NERVEGRAPH_DEBUG) throw e;
    console.error(`error: ${e?.message ?? e}`);
    console.error('run with NERVEGRAPH_DEBUG=1 for a stack trace');
    process.exit(1);
  },
);
