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
  classes?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export async function runScan(args: ScanArgs): Promise<number> {
  const root = path.resolve(args.path ?? '.');

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`error: path does not exist or is not a directory: ${root}`);
    return 3;
  }

  const graph = await buildGraph({
    root,
    profile: args.profile,
    extraIgnore: args.ignore,
    noGitignore: args.noGitignore,
    classes: args.classes,
  });

  if (graph.stats.files === 0) {
    console.error('error: no supported files found');
    return 4;
  }

  const outDir = path.resolve(args.out ?? '.nervegraph');
  try {
    await writeGraphAtomic(outDir, graph);
  } catch (e: any) {
    console.error(`error: failed to write artifacts: ${e?.message ?? e}`);
    return 1;
  }

  const outPath = path.join(outDir, 'graph.json');
  const size = Buffer.byteLength(JSON.stringify(graph));

  if (args.json) {
    console.log(JSON.stringify({ graph: outPath, stats: graph.stats, durationMs: graph.durationMs }));
  } else {
    printScanReport(graph, outPath, size, !!args.quiet);
  }

  return 0;
}
