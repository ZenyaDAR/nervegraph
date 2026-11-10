import path from 'node:path';
import { existsSync } from 'node:fs';
import { prevGraphPath, readGraph } from '../graph/io.ts';
import type { Graph } from '../graph/types.ts';

// What changed between two scans. The graph is deterministic, so committing
// graph.json makes a structural diff reviewable: a PR that quietly adds a
// cycle, orphans a file or raises a file's risk shows it here.

export interface DiffArgs {
  before?: string;
  after?: string;
  json?: boolean;
}

export interface GraphDiff {
  files: { added: string[]; removed: string[] };
  edges: { added: string[]; removed: string[] };
  cycles: { added: string[]; removed: string[] };
  orphaned: string[];
  adopted: string[];
  riskUp: { file: string; from: string; to: string }[];
}

const edgeKey = (e: { from: string; to: string; rel: string }) => `${e.from} → ${e.to} (${e.rel})`;
const cycleKey = (c: string[]) => c.join(' -> ');

export function diffGraphs(before: Graph, after: Graph): GraphDiff {
  const beforeNodes = new Map(before.nodes.map(n => [n.id, n]));
  const afterNodes = new Map(after.nodes.map(n => [n.id, n]));

  const added = [...afterNodes.keys()].filter(id => !beforeNodes.has(id)).sort();
  const removed = [...beforeNodes.keys()].filter(id => !afterNodes.has(id)).sort();

  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));

  const beforeCycles = new Set((before.cycles ?? []).map(cycleKey));
  const afterCycles = new Set((after.cycles ?? []).map(cycleKey));

  const RANK = { low: 0, medium: 1, high: 2 } as const;
  const riskUp: GraphDiff['riskUp'] = [];
  const orphaned: string[] = [];
  const adopted: string[] = [];

  for (const [id, now] of afterNodes) {
    const was = beforeNodes.get(id);
    if (!was) continue;
    if (RANK[now.risk] > RANK[was.risk]) riskUp.push({ file: id, from: was.risk, to: now.risk });
    if (now.orphan && !was.orphan) orphaned.push(id);
    if (!now.orphan && was.orphan) adopted.push(id);
  }

  const only = (a: Set<string>, b: Set<string>) => [...a].filter(k => !b.has(k)).sort();

  return {
    files: { added, removed },
    edges: { added: only(afterEdges, beforeEdges), removed: only(beforeEdges, afterEdges) },
    cycles: { added: only(afterCycles, beforeCycles), removed: only(beforeCycles, afterCycles) },
    orphaned: orphaned.sort(),
    adopted: adopted.sort(),
    riskUp: riskUp.sort((a, b) => a.file.localeCompare(b.file)),
  };
}

export async function runDiff(args: DiffArgs): Promise<number> {
  const afterPath = path.resolve(args.after ?? '.nervegraph/graph.json');
  // No arguments: what the last re-scan changed (scan keeps the one before it).
  const beforePath = args.before ? path.resolve(args.before) : prevGraphPath(afterPath);
  for (const p of [beforePath, afterPath]) {
    if (!existsSync(p)) {
      console.error(`error: graph not found at ${p}`);
      if (!args.before && p === beforePath) console.error('no previous scan yet: run nerve scan again after a change, or pass two graphs');
      return 5;
    }
  }

  const diff = diffGraphs(await readGraph(beforePath), await readGraph(afterPath));

  if (args.json) {
    console.log(JSON.stringify(diff));
    return 0;
  }

  const section = (title: string, rows: string[]) => {
    if (!rows.length) return;
    console.log(`\n  ${title} (${rows.length})`);
    for (const r of rows.slice(0, 20)) console.log(`    ${r}`);
    if (rows.length > 20) console.log(`    … ${rows.length - 20} more`);
  };

  section('files added', diff.files.added);
  section('files removed', diff.files.removed);
  section('edges added', diff.edges.added);
  section('edges removed', diff.edges.removed);
  section('cycles introduced', diff.cycles.added);
  section('cycles resolved', diff.cycles.removed);
  section('became orphans', diff.orphaned);
  section('no longer orphans', diff.adopted);
  section('risk increased', diff.riskUp.map(r => `${r.file}  ${r.from} → ${r.to}`));

  const total = diff.files.added.length + diff.files.removed.length +
    diff.edges.added.length + diff.edges.removed.length + diff.cycles.added.length +
    diff.cycles.removed.length + diff.orphaned.length + diff.adopted.length + diff.riskUp.length;
  if (!total) console.log('  no structural change');
  return 0;
}
