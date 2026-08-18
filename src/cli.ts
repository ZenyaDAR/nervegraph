#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runScan } from './commands/scan.ts';
import { runView } from './commands/view.ts';
import { runQuery } from './commands/query.ts';
import { runCheck } from './commands/check.ts';
import { runDiff } from './commands/diff.ts';
import { runExport } from './commands/export.ts';
import { runMcp } from './commands/mcp.ts';
import { VERSION } from './version.ts';

const HELP = `nervegraph ${VERSION}

Usage:
  nerve scan   [path]  [flags]   Scan project, write .nervegraph/graph.json
  nerve view           [flags]   Serve an interactive map locally
  nerve query  <file>  [flags]   What uses this file, and what it uses
  nerve check          [flags]   Fail the build when the graph breaks a budget
  nerve diff <a> [b]   [flags]   What changed structurally between two graphs
  nerve export         [flags]   The graph as mermaid or dot text
  nerve mcp            [flags]   Serve the graph to an agent over MCP (stdio)

scan flags:
  --profile <name>   shopify | js | poly | auto
  --out <dir>        default .nervegraph
  --ignore <glob>     repeatable
  --no-gitignore
  --no-git           skip git history (churn is not collected)
  --classes
  --pretty           indent graph.json (bigger, human-diffable)
  --json
  --quiet
  --watch            re-scan on change; an open viewer follows along

view flags:
  --port <n>          default 4210
  --no-open
  --graph <path>       default .nervegraph/graph.json

query flags:
  --json              machine-readable card, nothing else on stdout
  --depth <n>         also list neighbours up to n hops away
  --orphans           list every file nothing references
  --missing           list referenced files that are not on disk
  --unresolved        list references static analysis could not follow
  --risk <level>      list files at low | medium | high risk
  --dead-exports      list exports nothing imports
  --packages          fold the graph up to one node per package
  --duplicates        list groups of byte-identical files
  --cycles            list dependency cycles
  --graph <path>       default .nervegraph/graph.json

check flags:               (exit code 7 when a budget is broken)
  --max-cycles <n>
  --max-unresolved <n>
  --max-orphans <n>
  --allow-missing     tolerate references to files that are not on disk
  --no-dead-exports   fail if any export is unused
  --no-duplicates     fail if any two files are byte-identical
  --rules <file>      layer rules (default .nervegraph/rules.json when present)
  --json
  --graph <path>       default .nervegraph/graph.json

diff flags:
  --json              machine-readable diff, nothing else on stdout

export flags:
  --format <name>     mermaid (default) | dot
  --focus <file>      only this file's neighbourhood
  --depth <n>         how far around --focus to reach (default 1)
  --out <file>        write there instead of stdout
  --graph <path>       default .nervegraph/graph.json
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command) {
    console.log(HELP);
    process.exit(0);
  }

  if (command === 'scan') {
    const { values, positionals } = parseArgs({
      args: rest,
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
      allowPositionals: true,
    });
    const code = await runScan({
      path: positionals[0],
      profile: values.profile,
      out: values.out,
      ignore: values.ignore,
      noGitignore: values['no-gitignore'],
      noGit: values['no-git'],
      classes: values.classes,
      pretty: values.pretty,
      json: values.json,
      quiet: values.quiet,
      watch: values.watch,
    });
    process.exit(code);
  }

  if (command === 'view') {
    const { values } = parseArgs({
      args: rest,
      options: {
        port: { type: 'string' },
        'no-open': { type: 'boolean' },
        graph: { type: 'string' },
      },
      allowPositionals: true,
    });
    const code = await runView({
      port: values.port ? Number(values.port) : undefined,
      noOpen: values['no-open'],
      graph: values.graph,
    });
    process.exit(code);
  }

  if (command === 'query') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: {
        json: { type: 'boolean' },
        depth: { type: 'string' },
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
      allowPositionals: true,
    });
    const code = await runQuery({
      file: positionals[0],
      json: values.json,
      depth: values.depth ? Number(values.depth) : undefined,
      orphans: values.orphans,
      missing: values.missing,
      unresolved: values.unresolved,
      risk: values.risk,
      deadExports: values['dead-exports'],
      packages: values.packages,
      duplicates: values.duplicates,
      cycles: values.cycles,
      graph: values.graph,
    });
    process.exit(code);
  }

  if (command === 'check') {
    const { values } = parseArgs({
      args: rest,
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
      allowPositionals: true,
    });
    const num = (v?: string) => (v === undefined ? undefined : Number(v));
    const code = await runCheck({
      graph: values.graph,
      json: values.json,
      maxCycles: num(values['max-cycles']),
      maxUnresolved: num(values['max-unresolved']),
      maxOrphans: num(values['max-orphans']),
      allowMissing: values['allow-missing'],
      noDeadExports: values['no-dead-exports'],
      noDuplicates: values['no-duplicates'],
      rules: values.rules,
    });
    process.exit(code);
  }

  if (command === 'diff') {
    const { values, positionals } = parseArgs({
      args: rest,
      options: { json: { type: 'boolean' } },
      allowPositionals: true,
    });
    const code = await runDiff({ before: positionals[0], after: positionals[1], json: values.json });
    process.exit(code);
  }

  if (command === 'mcp') {
    const { values } = parseArgs({ args: rest, options: { graph: { type: 'string' } }, allowPositionals: true });
    const code = await runMcp({ graph: values.graph });
    process.exit(code);
  }

  if (command === 'export') {
    const { values } = parseArgs({
      args: rest,
      options: {
        format: { type: 'string' },
        focus: { type: 'string' },
        depth: { type: 'string' },
        out: { type: 'string' },
        graph: { type: 'string' },
      },
      allowPositionals: true,
    });
    const code = await runExport({
      format: values.format,
      focus: values.focus,
      depth: values.depth ? Number(values.depth) : undefined,
      out: values.out,
      graph: values.graph,
    });
    process.exit(code);
  }

  console.error(HELP);
  process.exit(2);
}

main().catch((e) => {
  if (process.env.NERVEGRAPH_DEBUG) throw e;
  console.error(`error: ${e?.message ?? e}`);
  console.error('run with NERVEGRAPH_DEBUG=1 for a stack trace');
  process.exit(1);
});
