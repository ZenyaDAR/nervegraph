import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readGraph } from '../graph/io.ts';
import type { Graph } from '../graph/types.ts';
import { isTestFile } from '../graph/analysis.ts';
import { buildAdjacency, cap, projectRoot, toJson, transitiveDependentIds, DEFAULT_LIMIT } from './query.ts';

// "I changed these files — what else is affected, and which tests cover it?"
// Read-only git calls only: status and diff, never anything that writes.

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Files changed in the working tree (staged, unstaged, untracked), plus every
 * file that differs from `base` when one is given — as graph ids, relative to
 * `root` (which may be a subdirectory of the repository).
 */
export function gitChangedFiles(root: string, base?: string): string[] {
  if (base !== undefined && (!base || base.startsWith('-'))) throw new Error(`invalid --base ref: "${base}"`);
  let prefix: string;
  try {
    prefix = git(root, ['rev-parse', '--show-prefix']).trim();
  } catch {
    throw new Error(`not a git repository (or git is not installed): ${root}`);
  }
  const paths = new Set<string>();
  for (const line of git(root, ['status', '--porcelain', '--untracked-files=all']).split('\n')) {
    if (line.length < 4) continue;
    const file = line.slice(3);
    const arrow = file.indexOf(' -> '); // a rename: the new path is what exists now
    paths.add(unquote(arrow >= 0 ? file.slice(arrow + 4) : file));
  }
  if (base !== undefined) {
    let out: string;
    try {
      out = git(root, ['diff', '--name-only', base, '--']);
    } catch (e: any) {
      throw new Error(`git diff against "${base}" failed: ${String(e?.stderr ?? e?.message ?? e).trim()}`);
    }
    for (const line of out.split('\n')) if (line.trim()) paths.add(unquote(line.trim()));
  }
  // Paths come relative to the repository top; keep those under the scanned root.
  return [...paths]
    .filter(p => p.startsWith(prefix))
    .map(p => p.slice(prefix.length))
    .sort();
}

/** git still quotes paths with control characters or quotes even with quotePath off. */
function unquote(p: string): string {
  return p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p;
}

/** The changed files, everything that depends on them, and the tests to run. */
export function changedReport(graph: Graph, files: string[], opts: { limit?: number; base?: string } = {}) {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const truncated: Record<string, number> = {};
  const nodeIds = new Set(graph.nodes.map(n => n.id));
  const changed = files.filter(f => nodeIds.has(f));
  const notInGraph = files.filter(f => !nodeIds.has(f));
  const changedSet = new Set(changed);

  const adj = buildAdjacency(graph);
  const direct = new Set<string>();
  const transitive = new Set<string>();
  for (const id of changed) {
    for (const e of adj.incoming.get(id) ?? []) if (!changedSet.has(e.from)) direct.add(e.from);
    for (const d of transitiveDependentIds(adj, id)) if (!changedSet.has(d)) transitive.add(d);
  }
  const sorted = (s: Iterable<string>) => [...s].sort();
  // A changed test is one to run too.
  const tests = sorted(new Set([...changed, ...transitive].filter(isTestFile)));

  return {
    ...(opts.base ? { base: opts.base } : {}),
    counts: {
      changed: changed.length, notInGraph: notInGraph.length,
      directDependents: direct.size, transitiveDependents: transitive.size, tests: tests.length,
    },
    changed: cap(changed, limit, 'changed', truncated),
    notInGraph: cap(notInGraph, limit, 'notInGraph', truncated),
    directDependents: cap(sorted(direct), limit, 'directDependents', truncated),
    transitiveDependents: cap(sorted(transitive), limit, 'transitiveDependents', truncated),
    tests: cap(tests, limit, 'tests', truncated),
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}

/** `nerve query --changed`. */
export async function runChanged(args: { graph?: string; base?: string; json?: boolean; pretty?: boolean; limit?: number }): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');
  const graph = await readGraph(graphPath);
  const report = changedReport(graph, gitChangedFiles(projectRoot(graph, graphPath), args.base), { limit: args.limit, base: args.base });
  if (args.json) { console.log(toJson(report, args.pretty)); return 0; }
  printChanged(report);
  return 0;
}

function printChanged(r: ReturnType<typeof changedReport>): void {
  const lines: string[] = [];
  const section = (title: string, rows: string[], total: number) => {
    if (!total) return;
    lines.push('', `  ${title} (${total})`, ...rows.map(f => `    ${f}`));
    if (rows.length < total) lines.push(`    … ${total - rows.length} more`);
  };
  lines.push(`changed files${r.base ? ` vs ${r.base}` : ''} (working tree)`);
  if (!r.counts.changed && !r.counts.notInGraph) lines.push('  nothing changed');
  section('changed', r.changed, r.counts.changed);
  section('changed, not in the graph (new, deleted or ignored — re-scan for new files)', r.notInGraph, r.counts.notInGraph);
  section('direct dependents', r.directDependents, r.counts.directDependents);
  section('all dependents', r.transitiveDependents, r.counts.transitiveDependents);
  section('tests to run', r.tests, r.counts.tests);
  console.log(lines.join('\n'));
}
