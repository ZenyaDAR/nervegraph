import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { buildGraph } from '../graph/build.ts';
import { writeGraphAtomic } from '../graph/io.ts';
import { printScanReport } from '../report.ts';

export interface ScanArgs {
  path?: string;
  profile?: string;
  out?: string;
  ignore?: string[];
  noGitignore?: boolean;
  noGit?: boolean;
  classes?: boolean;
  pretty?: boolean;
  json?: boolean;
  quiet?: boolean;
  watch?: boolean;
}

export async function runScan(args: ScanArgs): Promise<number> {
  const root = path.resolve(args.path ?? '.');

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`error: path does not exist or is not a directory: ${root}`);
    return 3;
  }

  const code = await scanOnce(args, root);
  if (code !== 0 || !args.watch) return code;
  return watchLoop(args, root);
}

async function scanOnce(args: ScanArgs, root: string): Promise<number> {
  const graph = await buildGraph({
    root,
    profile: args.profile,
    extraIgnore: args.ignore,
    noGitignore: args.noGitignore,
    noGit: args.noGit,
    classes: args.classes,
  });

  if (graph.stats.files === 0) {
    console.error('error: no supported files found');
    return 4;
  }

  const outDir = path.resolve(args.out ?? '.nervegraph');
  let size: number;
  try {
    size = await writeGraphAtomic(outDir, graph, args.pretty);
  } catch (e: any) {
    console.error(`error: failed to write artifacts: ${e?.message ?? e}`);
    return 1;
  }

  const outPath = path.join(outDir, 'graph.json');

  if (args.json) {
    console.log(JSON.stringify({ graph: outPath, stats: graph.stats, durationMs: graph.durationMs }));
  } else {
    printScanReport(graph, outPath, size, !!args.quiet);
  }

  return 0;
}

// Re-scan on change, so an open viewer (which watches graph.json over SSE)
// follows the code instead of showing yesterday's structure.
//
// ponytail: a whole re-scan per change, not an incremental one. A scan of a
// 1500-file theme is ~1s, and correctness of the delta is the hard part —
// make it incremental when a project shows up where the full scan hurts.
async function watchLoop(args: ScanArgs, root: string): Promise<number> {
  const { watch } = await import('node:fs');
  const DEBOUNCE_MS = 250;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let queued = false;

  async function rescan() {
    if (running) { queued = true; return; }
    running = true;
    try {
      await scanOnce(args, root);
    } catch (e: any) {
      console.error(`scan failed: ${e?.message ?? e}`);
    } finally {
      running = false;
      if (queued) { queued = false; void rescan(); }
    }
  }

  const watcher = watch(root, { recursive: true }, (_event, file) => {
    // Our own output would otherwise trigger the next scan forever.
    const name = String(file ?? '').replace(/\\/g, '/');
    if (name.includes('.nervegraph/') || name.includes('node_modules/') || name.includes('.git/')) return;
    clearTimeout(timer);
    timer = setTimeout(() => void rescan(), DEBOUNCE_MS);
  });

  if (!args.quiet) console.log('  watching for changes — press Ctrl+C to stop\n');

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => { watcher.close(); resolve(); });
  });
  return 0;
}
