import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { buildGraph, type ScanOptions } from '../graph/build.ts';
import { writeGraphAtomic } from '../graph/io.ts';
import { isExternal } from '../graph/analysis.ts';
import type { Graph } from '../graph/types.ts';
import { printScanReport } from '../report.ts';
import { PROFILES, type Profile } from '../scan/profile.ts';

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

  if (args.profile !== undefined && args.profile !== 'auto' && !PROFILES.includes(args.profile as Profile)) {
    console.error(`error: unknown profile "${args.profile}" (${[...PROFILES, 'auto'].join(' | ')})`);
    return 2;
  }

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
    const external = graph.unresolved.filter(isExternal).length;
    console.log(JSON.stringify({
      graph: outPath, stats: graph.stats, durationMs: graph.durationMs,
      unresolved: { external, unresolved: graph.unresolved.length - external },
    }));
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

  const outDir = path.resolve(args.out ?? '.nervegraph');
  const watcher = watch(root, { recursive: true }, (_event, file) => {
    if (isIgnoredWatchEvent(root, outDir, file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void rescan(), DEBOUNCE_MS);
  });

  // stderr under --json, so stdout stays one JSON document per scan.
  if (!args.quiet) (args.json ? console.error : console.log)('  watching for changes — press Ctrl+C to stop\n');

  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => { watcher.close(); resolve(); });
  });
  return 0;
}

const IGNORED_DIRS = new Set(['node_modules', '.git']);

/**
 * True for a watch event that must not trigger a re-scan: anything inside the
 * output dir (our own write would otherwise re-scan forever — Windows reports
 * the bare dir name `.nervegraph`, and `--out` can point anywhere), or inside
 * node_modules / .git.
 */
export function isIgnoredWatchEvent(root: string, outDir: string, file: string | Buffer | null | undefined): boolean {
  if (file == null) return false;
  const name = String(file);
  if (name.split(/[\\/]/).some(part => IGNORED_DIRS.has(part))) return true;
  const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const abs = fold(path.resolve(root, name));
  const out = fold(path.resolve(outDir));
  return abs === out || abs.startsWith(out + path.sep);
}
