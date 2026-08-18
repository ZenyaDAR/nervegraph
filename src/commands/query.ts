import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readGraph } from '../graph/io.ts';
import type { Graph, GraphNode, GraphEdge } from '../graph/types.ts';
import { foldToPackages } from '../graph/analysis.ts';

// The agent-facing read side of graph.json. It answers the one question worth
// asking before an edit — "what breaks if I touch this" — without the agent
// pulling a megabyte of JSON into its context.

export interface QueryArgs {
  file?: string;
  graph?: string;
  json?: boolean;
  depth?: number;
  orphans?: boolean;
  missing?: boolean;
  unresolved?: boolean;
  risk?: string;
  deadExports?: boolean;
  duplicates?: boolean;
  cycles?: boolean;
  packages?: boolean;
}

export async function runQuery(args: QueryArgs): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');
  if (!existsSync(graphPath)) {
    console.error(`error: graph not found at ${graphPath}`);
    console.error('run: nerve scan');
    return 5;
  }
  const graph = await readGraph(graphPath);

  const listMode = args.orphans || args.missing || args.unresolved || args.risk ||
    args.deadExports || args.duplicates || args.cycles || args.packages;
  if (listMode) return printList(graph, args);

  if (!args.file) {
    console.error('error: nerve query <file>  (or --orphans / --missing / --unresolved / --risk <level>)');
    return 2;
  }

  const id = normalizeId(args.file);
  const found = findNode(graph, id);
  if (found.length === 0) {
    console.error(`error: ${id} is not in the graph`);
    console.error('paths are relative to the scanned root; run "nerve scan" if the file is new');
    return 5;
  }
  if (found.length > 1) {
    console.error(`error: ${id} matches ${found.length} files:`);
    for (const n of found.slice(0, 20)) console.error(`  ${n.id}`);
    if (found.length > 20) console.error(`  … ${found.length - 20} more`);
    return 2;
  }
  const node = found[0];

  const usedBy = graph.edges.filter(e => e.to === node.id);
  const uses = graph.edges.filter(e => e.from === node.id);
  const card = {
    file: node.id,
    type: node.type,
    lang: node.lang,
    loc: node.loc,
    size: node.size,
    risk: node.risk,
    orphan: node.orphan,
    entrypoint: node.entrypoint,
    missing: !!node.missing,
    counts: { in: node.in, out: node.out },
    // Collected during the scan and, until now, read by nothing. The card is
    // where they answer something: which symbols this file offers, and (under
    // --classes) which class names it defines or uses.
    ...(node.exports ? { exports: node.exports } : {}),
    ...(node.deadExports ? { deadExports: node.deadExports } : {}),
    ...(node.classes ? { classes: node.classes } : {}),
    usedBy: usedBy.map(refOf(e => e.from)),
    uses: uses.map(refOf(e => e.to)),
    transitiveDependents: transitiveDependents(graph, node.id),
    ...(args.depth ? { neighbors: neighbors(graph, node.id, args.depth) } : {}),
    graphScannedAt: graph.scannedAt,
    stale: isStale(graph, node),
  };

  if (args.json) {
    console.log(JSON.stringify(card, null, 2));
    return 0;
  }
  printCard(card);
  return 0;
}

function refOf(pick: (e: GraphEdge) => string) {
  return (e: GraphEdge) => ({ file: pick(e), rel: e.rel, line: e.line, raw: e.raw });
}

/** Everything that reaches this file, however indirectly — the real blast radius. */
function transitiveDependents(graph: Graph, id: string): number {
  const incoming = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = incoming.get(e.to);
    if (list) list.push(e.from); else incoming.set(e.to, [e.from]);
  }
  const seen = new Set<string>();
  const queue = [id];
  while (queue.length) {
    for (const from of incoming.get(queue.shift()!) ?? []) {
      if (seen.has(from)) continue;
      seen.add(from);
      queue.push(from);
    }
  }
  return seen.size;
}

function neighbors(graph: Graph, id: string, depth: number): string[] {
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of graph.edges) {
        if (e.from === cur && !seen.has(e.to)) { seen.add(e.to); next.push(e.to); }
        if (e.to === cur && !seen.has(e.from)) { seen.add(e.from); next.push(e.from); }
      }
    }
    frontier = next;
  }
  seen.delete(id);
  return [...seen].sort();
}

// Only the queried file is stat'ed: it is the file the caller is about to edit,
// and stat'ing the whole project to answer one question would cost more than
// the scan it is warning about.
function isStale(graph: Graph, node: GraphNode): boolean {
  if (node.missing) return false;
  try {
    const abs = path.join(graph.root, node.id);
    return statSync(abs).mtimeMs > new Date(graph.scannedAt).getTime();
  } catch {
    return true; // the file is gone since the scan, which is the staler case
  }
}

function printList(graph: Graph, args: QueryArgs): number {
  if (args.unresolved) {
    const rows = graph.unresolved;
    if (args.json) { console.log(JSON.stringify({ unresolved: rows }, null, 2)); return 0; }
    for (const u of rows) console.log(`${u.from}:${u.line}  ${u.rel}  ${u.reason}  ${u.raw}`);
    if (!rows.length) console.log('no unresolved references');
    return 0;
  }

  if (args.packages) {
    const pkg = foldToPackages(graph);
    if (args.json) { console.log(JSON.stringify(pkg, null, 2)); return 0; }
    for (const p of pkg.packages) console.log(`${p.id.padEnd(40)} ${p.files} files · ${p.in} in · ${p.out} out`);
    if (pkg.edges.length) {
      console.log('');
      for (const e of pkg.edges) console.log(`${e.from} -> ${e.to}  (${e.count})`);
    }
    return 0;
  }

  if (args.duplicates || args.cycles) {
    const key = args.duplicates ? 'duplicates' : 'cycles';
    const groups = (args.duplicates ? graph.duplicates : graph.cycles) ?? [];
    if (args.json) { console.log(JSON.stringify({ [key]: groups }, null, 2)); return 0; }
    for (const g of groups) console.log(g.join(args.duplicates ? '  ==  ' : ' -> '));
    if (!groups.length) console.log(args.duplicates ? 'no duplicate files' : 'no cycles');
    return 0;
  }

  if (args.deadExports) {
    const rows = graph.nodes.filter(n => n.deadExports?.length);
    if (args.json) {
      console.log(JSON.stringify({ files: rows.map(n => ({ file: n.id, deadExports: n.deadExports })) }, null, 2));
      return 0;
    }
    for (const n of rows) console.log(`${n.id.padEnd(50)} ${n.deadExports!.join(', ')}`);
    if (!rows.length) console.log('no unused exports found');
    return 0;
  }

  const files = graph.nodes.filter(n => {
    if (args.orphans && !n.orphan) return false;
    if (args.missing && !n.missing) return false;
    if (args.risk && n.risk !== args.risk) return false;
    return true;
  });

  if (args.json) {
    console.log(JSON.stringify({
      files: files.map(n => ({
        file: n.id, type: n.type, lang: n.lang, loc: n.loc,
        risk: n.risk, orphan: n.orphan, entrypoint: n.entrypoint, missing: !!n.missing,
        counts: { in: n.in, out: n.out },
      })),
    }, null, 2));
    return 0;
  }
  for (const n of files) console.log(`${n.id.padEnd(50)} ${n.in} in · ${n.out} out · risk ${n.risk}`);
  if (!files.length) console.log('nothing matched');
  return 0;
}

function printCard(card: any): void {
  const lines: string[] = [];
  lines.push(`${card.file}`);
  lines.push(`  ${card.lang} ${card.type} · ${card.loc} loc · risk ${card.risk}${card.entrypoint ? ' · entrypoint' : ''}${card.orphan ? ' · orphan' : ''}${card.missing ? ' · MISSING' : ''}`);
  lines.push(`  ${card.counts.in} dependents (${card.transitiveDependents} transitive) · ${card.counts.out} dependencies`);
  if (card.stale) lines.push('  ⚠ file changed since the scan — run: nerve scan');
  if (card.usedBy.length) {
    lines.push('');
    lines.push('  used by');
    for (const r of card.usedBy.slice(0, 10)) lines.push(`    ${r.file}:${r.line}  ${r.rel}`);
    if (card.usedBy.length > 10) lines.push(`    … ${card.usedBy.length - 10} more`);
  }
  if (card.uses.length) {
    lines.push('');
    lines.push('  uses');
    for (const r of card.uses.slice(0, 10)) lines.push(`    ${r.file}:${r.line}  ${r.rel}`);
    if (card.uses.length > 10) lines.push(`    … ${card.uses.length - 10} more`);
  }
  console.log(lines.join('\n'));
}

/**
 * Resolve the argument the way a person types it: exact path,
 * then path suffix, then basename with or without its extension. Returns every
 * match at the first tier that hits any — an ambiguous name is the caller's to
 * disambiguate, not ours to guess.
 */
function findNode(graph: Graph, id: string): GraphNode[] {
  const want = id.toLowerCase();
  const tiers: ((n: GraphNode) => boolean)[] = [
    n => n.id.toLowerCase() === want,
    n => n.id.toLowerCase().endsWith('/' + want),
    n => basename(n.id).toLowerCase() === want,
    n => stripExt(basename(n.id)).toLowerCase() === want,
  ];
  for (const match of tiers) {
    const hits = graph.nodes.filter(match);
    if (hits.length) return hits;
  }
  return [];
}

function basename(id: string): string {
  return id.slice(id.lastIndexOf('/') + 1);
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

function normalizeId(file: string): string {
  return file.replace(/^\.\//, '').split(path.sep).join('/');
}
