#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runScan } from './commands/scan.ts';
import { runView } from './commands/view.ts';
import { runQuery } from './commands/query.ts';
import { VERSION } from './version.ts';

const HELP = `nervegraph ${VERSION}

Usage:
  nerve scan   [path]  [flags]   Scan project, write .nervegraph/graph.json
  nerve view           [flags]   Serve an interactive map locally
  nerve query  <file>  [flags]   What uses this file, and what it uses

scan flags:
  --profile <name>   shopify | js | poly | auto
  --out <dir>        default .nervegraph
  --ignore <glob>     repeatable
  --no-gitignore
  --classes
  --force
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
        classes: { type: 'boolean' },
        force: { type: 'boolean' },
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
      classes: values.classes,
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
