#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runScan } from './commands/scan.ts';
import { runView } from './commands/view.ts';

const HELP = `nervegraph 0.1.0

Usage:
  nerve scan   [path]  [flags]   Scan project, write .nervegraph/graph.json
  nerve view           [flags]   Serve an interactive map locally

scan flags:
  --profile <name>   shopify | js | auto
  --out <dir>        default .nervegraph
  --ignore <glob>     repeatable
  --no-gitignore
  --classes
  --force
  --json
  --quiet

view flags:
  --port <n>          default 4210
  --no-open
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

  console.error(HELP);
  process.exit(2);
}

main().catch((e) => {
  if (process.env.NERVEGRAPH_DEBUG) throw e;
  console.error(`error: ${e?.message ?? e}`);
  console.error('run with NERVEGRAPH_DEBUG=1 for a stack trace');
  process.exit(1);
});
