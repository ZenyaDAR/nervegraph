import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { readGraph, projectDirOf } from '../graph/io.ts';
import type { Graph, GraphNode, GraphEdge } from '../graph/types.ts';
import { foldToPackages, fileKind, isExternal, isTestFile, FILE_KINDS } from '../graph/analysis.ts';

// The agent-facing read side of graph.json. It answers the one question worth
// asking before an edit — "what breaks if I touch this" — without the agent
// pulling a megabyte of JSON into its context.

export type Direction = 'in' | 'out' | 'both';

export interface QueryArgs {
  file?: string;
  graph?: string;
  json?: boolean;
  /** Indent JSON output; compact (one line) otherwise. */
  pretty?: boolean;
  /** Include the source text of every reference. */
  raw?: boolean;
  /** Cap every list at this many entries; 0 = no cap. */
  limit?: number;
  /** List modes: keep only these row fields. */
  fields?: string[];
  depth?: number;
  direction?: Direction;
  /** List every transitive dependent, not just their count. */
  transitive?: boolean;
  /** --orphans: include tests, fixtures, docs, config, … (default: code only). */
  all?: boolean;
  symbol?: string;
  orphans?: boolean;
  missing?: boolean;
  unresolved?: boolean;
  risk?: string;
  deadExports?: boolean;
  duplicates?: boolean;
  cycles?: boolean;
  packages?: boolean;
}

/** Entries per list unless --limit says otherwise: enough to act on, small enough for a context window. */
export const DEFAULT_LIMIT = 50;

export function toJson(value: unknown, pretty?: boolean): string {
  return pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

/**
 * Cap `list` at `limit` (0 = no cap). How many entries were dropped is
 * recorded under `truncated[key]`, so a capped answer never looks complete.
 */
export function cap<T>(list: T[], limit: number, key: string, truncated: Record<string, number>): T[] {
  if (!limit || list.length <= limit) return list;
  truncated[key] = list.length - limit;
  return list.slice(0, limit);
}

export async function runQuery(args: QueryArgs): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');
  if (!existsSync(graphPath)) {
    console.error(`error: graph not found at ${graphPath}`);
    console.error('run: nerve scan');
    return 5;
  }
  const graph = await readGraph(graphPath);
  const limit = args.limit ?? DEFAULT_LIMIT;

  if (args.symbol !== undefined) {
    const report = symbolReport(graph, args.symbol, limit);
    if (args.json) { console.log(toJson(report, args.pretty)); return 0; }
    printSymbol(report);
    return 0;
  }

  const kind = listKindOf(args);
  if (kind) return printList(graph, kind, args);

  if (!args.file) {
    console.error('error: nerve query <file>  (or --symbol <name> / --changed / --orphans / --missing / --unresolved / --risk <level> …)');
    return 2;
  }

  const found = lookupNode(graph, args.file, graphPath);
  if (!found.node) {
    reportLookupFailure(found);
    return found.candidates.length ? 2 : 5;
  }

  const card = fileCard(graph, found.node, {
    depth: args.depth, direction: args.direction, graphPath, raw: args.raw, limit, transitive: args.transitive,
  });
  if (args.json) {
    console.log(toJson(card, args.pretty));
    return 0;
  }
  printCard(card);
  return 0;
}

/** The directory the graph's ids are relative to, on this machine. */
export function projectRoot(graph: Graph, graphPath: string): string {
  return existsSync(graph.root) ? graph.root : projectDirOf(graphPath);
}

/** One file's references to (or from) another, folded onto one entry. */
export interface FileRef {
  file: string;
  /** Relation(s), comma-joined when one file references the other in several ways. */
  rel: string;
  lines: number[];
  /** Bindings named by these references, when the scanner knows them. */
  names?: string[];
  /** Source text of each reference, parallel to `lines`; only with `raw`. */
  raw?: string[];
}

export interface CardOptions {
  depth?: number;
  direction?: Direction;
  graphPath?: string;
  adjacency?: Adjacency;
  raw?: boolean;
  /** Cap per list; 0 = no cap. Default DEFAULT_LIMIT. */
  limit?: number;
  transitive?: boolean;
}

/**
 * The card `nerve query` prints and the MCP query tool returns — one builder,
 * so the two can never disagree about what a file looks like.
 */
export function fileCard(graph: Graph, node: GraphNode, opts: CardOptions = {}) {
  const adj = opts.adjacency ?? buildAdjacency(graph);
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const truncated: Record<string, number> = {};
  const dependents = [...transitiveDependentIds(adj, node.id)].sort();
  const tests = dependents.filter(isTestFile);

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
    ...(node.churn !== undefined ? { churn: node.churn } : {}),
    ...(node.exports ? { exports: node.exports } : {}),
    ...(node.deadExports ? { deadExports: node.deadExports } : {}),
    ...(node.classes ? { classes: node.classes } : {}),
    usedBy: cap(groupRefs(adj.incoming.get(node.id) ?? [], e => e.from, opts.raw), limit, 'usedBy', truncated),
    uses: cap(groupRefs(adj.outgoing.get(node.id) ?? [], e => e.to, opts.raw), limit, 'uses', truncated),
    transitiveDependents: dependents.length,
    // Test files that reach this one, however indirectly: what to run after editing it.
    tests: cap(tests, limit, 'tests', truncated),
    ...(opts.transitive ? { dependents: cap(dependents, limit, 'dependents', truncated) } : {}),
    ...(opts.depth ? { neighbors: cap(neighbors(adj, node.id, opts.depth, opts.direction), limit, 'neighbors', truncated) } : {}),
    ...(Object.keys(truncated).length ? { truncated } : {}),
    graphScannedAt: graph.scannedAt,
    stale: isStale(graph, node, opts.graphPath),
  };
  return card;
}

export type FileCard = ReturnType<typeof fileCard>;

/**
 * Edges folded per file: one entry with every line, instead of one entry per
 * line. The repeated file path was most of a hub's card.
 */
function groupRefs(edges: GraphEdge[], pick: (e: GraphEdge) => string, raw?: boolean): FileRef[] {
  const groups = new Map<string, FileRef>();
  for (const e of edges) {
    const file = pick(e);
    let g = groups.get(file);
    if (!g) {
      g = { file, rel: e.rel, lines: [] };
      groups.set(file, g);
    } else if (!g.rel.split(',').includes(e.rel)) {
      g.rel += ',' + e.rel;
    }
    g.lines.push(e.line);
    for (const name of e.names ?? []) {
      if (!g.names) g.names = [name];
      else if (!g.names.includes(name)) g.names.push(name);
    }
    if (raw) (g.raw ??= []).push(e.raw);
  }
  return [...groups.values()];
}

/** Edges indexed both ways, built once per query instead of scanned per hop. */
export interface Adjacency {
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
}

export function buildAdjacency(graph: Graph): Adjacency {
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const out = outgoing.get(e.from);
    if (out) out.push(e); else outgoing.set(e.from, [e]);
    const inc = incoming.get(e.to);
    if (inc) inc.push(e); else incoming.set(e.to, [e]);
  }
  return { outgoing, incoming };
}

/** Everything that reaches this file, however indirectly — the real blast radius. */
export function transitiveDependentIds(adj: Adjacency, id: string): Set<string> {
  const seen = new Set<string>();
  const queue = [id];
  for (let i = 0; i < queue.length; i++) {
    for (const e of adj.incoming.get(queue[i]) ?? []) {
      if (seen.has(e.from) || e.from === id) continue;
      seen.add(e.from);
      queue.push(e.from);
    }
  }
  return seen;
}

/** Everything within `depth` hops of `id` (following `direction`), `id` included. */
export function neighborhood(adj: Adjacency, id: string, depth: number, direction: Direction = 'both'): Set<string> {
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      if (direction !== 'in') for (const e of adj.outgoing.get(cur) ?? []) if (!seen.has(e.to)) { seen.add(e.to); next.push(e.to); }
      if (direction !== 'out') for (const e of adj.incoming.get(cur) ?? []) if (!seen.has(e.from)) { seen.add(e.from); next.push(e.from); }
    }
    frontier = next;
  }
  return seen;
}

function neighbors(adj: Adjacency, id: string, depth: number, direction?: Direction): string[] {
  const seen = neighborhood(adj, id, depth, direction);
  seen.delete(id);
  return [...seen].sort();
}

// Only the queried file is stat'ed: it is the file the caller is about to edit,
// and stat'ing the whole project to answer one question would cost more than
// the scan it is warning about.
function isStale(graph: Graph, node: GraphNode, graphPath?: string): boolean {
  if (node.missing) return false;
  // A graph scanned on another machine or checkout records a root that does
  // not exist here; judging every file against it would call them all stale.
  const root = existsSync(graph.root) || !graphPath ? graph.root : projectDirOf(graphPath);
  return fileChangedSince(root, node.id, new Date(graph.scannedAt).getTime());
}

function fileChangedSince(root: string, id: string, since: number): boolean {
  try {
    return statSync(path.join(root, id)).mtimeMs > since;
  } catch {
    return true; // the file is gone since the scan, which is the staler case
  }
}

/** Files on disk that changed or vanished since the scan (one stat per node). */
export function staleFiles(graph: Graph, graphPath?: string): string[] {
  const root = existsSync(graph.root) || !graphPath ? graph.root : projectDirOf(graphPath);
  const since = new Date(graph.scannedAt).getTime();
  return graph.nodes.filter(n => !n.missing && fileChangedSince(root, n.id, since)).map(n => n.id);
}

// --- list modes ----------------------------------------------------------------

export const LIST_KINDS = ['orphans', 'missing', 'unresolved', 'risk', 'dead-exports', 'duplicates', 'cycles', 'packages'] as const;
export type ListKind = typeof LIST_KINDS[number];

function listKindOf(args: QueryArgs): ListKind | undefined {
  if (args.unresolved) return 'unresolved';
  if (args.packages) return 'packages';
  if (args.duplicates) return 'duplicates';
  if (args.cycles) return 'cycles';
  if (args.deadExports) return 'dead-exports';
  if (args.orphans) return 'orphans';
  if (args.missing) return 'missing';
  if (args.risk) return 'risk';
  return undefined;
}

export interface ListOptions {
  risk?: string;
  all?: boolean;
  limit?: number;
  fields?: string[];
}

/**
 * One list as JSON-ready data — shared by `nerve query --<kind> --json` and the
 * MCP list tool. Rows are capped at `limit`; `total` is the uncapped count.
 */
export function listResult(graph: Graph, kind: ListKind, opts: ListOptions = {}): Record<string, unknown> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const truncated: Record<string, number> = {};
  const { key, rows, extra } = listRows(graph, kind, opts);
  let shown = cap(rows, limit, key, truncated);
  if (opts.fields?.length && shown.length && !Array.isArray(shown[0])) {
    const keep = opts.fields;
    shown = shown.map(r => Object.fromEntries(keep.filter(f => f in r).map(f => [f, r[f]])));
  }
  return { [key]: shown, total: rows.length, ...extra, ...(Object.keys(truncated).length ? { truncated } : {}) };
}

function fileRow(n: GraphNode, withKind = false): Record<string, any> {
  return {
    file: n.id, type: n.type, lang: n.lang, loc: n.loc, risk: n.risk,
    ...(withKind ? { kind: fileKind(n.id) } : {}),
    ...(n.entrypoint ? { entrypoint: true } : {}),
    counts: { in: n.in, out: n.out },
  };
}

function listRows(graph: Graph, kind: ListKind, opts: ListOptions): { key: string; rows: any[]; extra: Record<string, unknown> } {
  switch (kind) {
    case 'unresolved': {
      // The references worth a look first; external ones are expected.
      const genuine = graph.unresolved.filter(u => !isExternal(u));
      const external = graph.unresolved.filter(isExternal);
      return { key: 'unresolved', rows: [...genuine, ...external], extra: { external: external.length, genuine: genuine.length } };
    }
    case 'packages': {
      const pkg = foldToPackages(graph);
      return { key: 'packages', rows: pkg.packages, extra: { edges: pkg.edges } };
    }
    case 'duplicates':
      return { key: 'duplicates', rows: graph.duplicates ?? [], extra: {} };
    case 'cycles':
      return { key: 'cycles', rows: graph.cycles ?? [], extra: {} };
    case 'dead-exports':
      return { key: 'files', rows: graph.nodes.filter(n => n.deadExports?.length).map(n => ({ file: n.id, deadExports: n.deadExports })), extra: {} };
    case 'orphans': {
      // Tests, fixtures, docs and config are entered from outside the import
      // graph; listing them as "nothing uses this" buried the real candidates.
      const orphans = graph.nodes.filter(n => n.orphan);
      const byKind: Record<string, number> = {};
      for (const n of orphans) { const k = fileKind(n.id); byKind[k] = (byKind[k] ?? 0) + 1; }
      const rows = orphans.filter(n => opts.all || fileKind(n.id) === 'code').map(n => fileRow(n, true));
      return { key: 'files', rows, extra: { byKind: sortKinds(byKind), ...(opts.all ? {} : { hint: 'code orphans only; all: true / --all lists every kind' }) } };
    }
    case 'missing':
      return { key: 'files', rows: graph.nodes.filter(n => n.missing).map(n => fileRow(n)), extra: {} };
    case 'risk': {
      const risk = opts.risk ?? 'high';
      return { key: 'files', rows: graph.nodes.filter(n => n.risk === risk).map(n => fileRow(n)), extra: {} };
    }
  }
}

export function sortKinds(byKind: Record<string, number>): Record<string, number> {
  return Object.fromEntries(FILE_KINDS.filter(k => byKind[k]).map(k => [k, byKind[k]]));
}

function printList(graph: Graph, kind: ListKind, args: QueryArgs): number {
  const result = listResult(graph, kind, { risk: args.risk, all: args.all, limit: args.limit, fields: args.fields });
  if (args.json) { console.log(toJson(result, args.pretty)); return 0; }

  const key = kind === 'unresolved' || kind === 'packages' || kind === 'duplicates' || kind === 'cycles' ? kind : 'files';
  const rows = result[key] as any[];
  const line: Record<ListKind, (r: any) => string> = {
    unresolved: u => `${u.from}:${u.line}  ${u.rel}  ${u.reason}  ${u.raw}`,
    packages: p => `${p.id.padEnd(40)} ${p.files} files · ${p.in} in · ${p.out} out`,
    duplicates: g => g.join('  ==  '),
    cycles: g => g.join(' -> '),
    'dead-exports': r => `${r.file.padEnd(50)} ${r.deadExports.join(', ')}`,
    orphans: r => `${r.file.padEnd(50)} ${r.kind}`,
    missing: r => `${r.file.padEnd(50)} ${r.counts.in} in`,
    risk: r => `${r.file.padEnd(50)} ${r.counts.in} in · ${r.counts.out} out · risk ${r.risk}`,
  };
  const empty: Record<ListKind, string> = {
    unresolved: 'no unresolved references', packages: 'no packages', duplicates: 'no duplicate files',
    cycles: 'no cycles', 'dead-exports': 'no unused exports found', orphans: 'no orphan code files',
    missing: 'nothing matched', risk: 'nothing matched',
  };
  for (const r of rows) console.log(line[kind](r));
  if (!rows.length) console.log(empty[kind]);
  const dropped = (result.truncated as Record<string, number> | undefined)?.[key];
  if (dropped) console.log(`… ${dropped} more (--limit 0 lists all)`);
  if (kind === 'packages' && (result.edges as any[]).length) {
    console.log('');
    for (const e of result.edges as any[]) console.log(`${e.from} -> ${e.to}  (${e.count})`);
  }
  if (kind === 'orphans' && !args.all) {
    const others = Object.entries(result.byKind as Record<string, number>).filter(([k]) => k !== 'code');
    if (others.length) console.log(`(not shown: ${others.map(([k, n]) => `${n} ${k}`).join(', ')} — --all lists them)`);
  }
  if (kind === 'unresolved') console.log(`${result.genuine} unresolved · ${result.external} external (packages, builtins, URLs)`);
  return 0;
}

// --- symbols -------------------------------------------------------------------

export interface SymbolSite { file: string; line: number; from: string }

/**
 * Where a symbol is exported, and every import site that names it (from edge
 * `names`). A namespace import (`import * as x`) of an exporting file may use
 * it too, so those are listed apart, as possible sites.
 */
export function symbolReport(graph: Graph, name: string, limit = DEFAULT_LIMIT) {
  const truncated: Record<string, number> = {};
  const exportedBy = graph.nodes.filter(n => n.exports?.includes(name)).map(n => n.id);
  const exporters = new Set(exportedBy);
  const importedBy: SymbolSite[] = [];
  const viaNamespace: SymbolSite[] = [];
  for (const e of graph.edges) {
    if (!e.names) continue;
    if (e.names.includes(name)) importedBy.push({ file: e.from, line: e.line, from: e.to });
    else if (e.names.includes('*') && exporters.has(e.to)) viaNamespace.push({ file: e.from, line: e.line, from: e.to });
  }
  let similar: string[] | undefined;
  if (!exportedBy.length && !importedBy.length) {
    const want = name.toLowerCase();
    const names = new Set<string>();
    for (const n of graph.nodes) for (const x of n.exports ?? []) if (x.toLowerCase().includes(want)) names.add(x);
    similar = [...names].sort().slice(0, 10);
  }
  return {
    symbol: name,
    exportedBy: cap(exportedBy, limit, 'exportedBy', truncated),
    importedBy: cap(importedBy, limit, 'importedBy', truncated),
    counts: { exportedBy: exportedBy.length, importedBy: importedBy.length, viaNamespace: viaNamespace.length },
    ...(viaNamespace.length ? { viaNamespace: cap(viaNamespace, limit, 'viaNamespace', truncated) } : {}),
    ...(similar?.length ? { similar } : {}),
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}

function printSymbol(r: ReturnType<typeof symbolReport>): void {
  const lines = [r.symbol];
  if (!r.counts.exportedBy && !r.counts.importedBy) {
    lines.push('  no file exports or imports it by name');
    if (r.similar) lines.push(`  similar exports: ${r.similar.join(', ')}`);
  }
  if (r.exportedBy.length) lines.push('', '  exported by', ...r.exportedBy.map(f => `    ${f}`));
  if (r.importedBy.length) lines.push('', '  imported by', ...r.importedBy.map(s => `    ${s.file}:${s.line}  ← ${s.from}`));
  if (r.viaNamespace) lines.push('', '  maybe used via a namespace import', ...r.viaNamespace.map(s => `    ${s.file}:${s.line}  ← ${s.from}`));
  if (r.truncated) lines.push('', `  (capped: ${Object.entries(r.truncated).map(([k, n]) => `${n} more ${k}`).join(', ')}; --limit 0 lists all)`);
  console.log(lines.join('\n'));
}

function printCard(card: FileCard): void {
  const lines: string[] = [];
  lines.push(`${card.file}`);
  lines.push(`  ${card.lang} ${card.type} · ${card.loc} loc · risk ${card.risk}${card.entrypoint ? ' · entrypoint' : ''}${card.orphan ? ' · orphan' : ''}${card.missing ? ' · MISSING' : ''}`);
  lines.push(`  ${card.counts.in} dependents (${card.transitiveDependents} transitive) · ${card.counts.out} dependencies`);
  if (card.stale) lines.push('  ⚠ file changed since the scan — run: nerve scan');
  const refs = (title: string, list: FileRef[], more = 0) => {
    if (!list.length) return;
    lines.push('', `  ${title}`);
    for (const r of list.slice(0, 10)) lines.push(`    ${r.file}:${r.lines.join(',')}  ${r.rel}${r.names ? `  {${r.names.join(', ')}}` : ''}`);
    const hidden = list.length - Math.min(list.length, 10) + more;
    if (hidden) lines.push(`    … ${hidden} more`);
  };
  refs('used by', card.usedBy, card.truncated?.usedBy);
  refs('uses', card.uses, card.truncated?.uses);
  if (card.tests.length) {
    lines.push('', '  tests that reach it');
    for (const t of card.tests.slice(0, 10)) lines.push(`    ${t}`);
    const hidden = card.tests.length - Math.min(card.tests.length, 10) + (card.truncated?.tests ?? 0);
    if (hidden) lines.push(`    … ${hidden} more`);
  }
  if ('dependents' in card && card.dependents?.length) lines.push('', '  all dependents', ...card.dependents.map(f => `    ${f}`));
  if ('neighbors' in card && card.neighbors?.length) lines.push('', '  neighbours', ...card.neighbors.map(f => `    ${f}`));
  console.log(lines.join('\n'));
}

// --- node lookup ---------------------------------------------------------------

export interface NodeLookup {
  /** The argument after normalisation, for messages. */
  query: string;
  /** Set when exactly one node matched. */
  node?: GraphNode;
  /** Every match when the name was ambiguous; empty when nothing matched. */
  candidates: GraphNode[];
}

/**
 * The one way every command (query, export --focus, mcp) turns what a person
 * or agent typed into a node: normalise, then match by tiers.
 */
export function lookupNode(graph: Graph, input: string, graphPath?: string): NodeLookup {
  const roots = [graph.root, graphPath && projectDirOf(graphPath)].filter((r): r is string => !!r);
  const query = normalizeId(input, roots);
  const found = query ? findNode(graph, query) : [];
  if (found.length === 1) return { query, node: found[0], candidates: [] };
  return { query, candidates: found };
}

/** Print why a lookup did not land on one node, to stderr. */
export function reportLookupFailure(found: NodeLookup): void {
  if (found.candidates.length) {
    console.error(`error: ${found.query} matches ${found.candidates.length} files:`);
    for (const n of found.candidates.slice(0, 20)) console.error(`  ${n.id}`);
    if (found.candidates.length > 20) console.error(`  … ${found.candidates.length - 20} more`);
    return;
  }
  console.error(`error: ${found.query} is not in the graph`);
  console.error('paths are relative to the scanned root; run "nerve scan" if the file is new');
}

/**
 * Resolve the argument the way a person types it: exact path,
 * then path suffix, then basename with or without its extension. Returns every
 * match at the first tier that hits any — an ambiguous name is the caller's to
 * disambiguate, not ours to guess.
 */
export function findNode(graph: Graph, id: string): GraphNode[] {
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

/**
 * Turn a typed path into graph-id form: forward slashes, no leading `./`, and
 * an absolute path made relative to the first of `roots` that contains it
 * (case-insensitively on Windows, where `C:\Proj` and `c:\proj` are one dir).
 */
export function normalizeId(file: string, roots: string[] = []): string {
  let id = file.trim().replace(/\\/g, '/');
  if (path.isAbsolute(file) || /^[A-Za-z]:\//.test(id)) {
    const fold = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
    for (const root of roots) {
      const prefix = root.replace(/\\/g, '/').replace(/\/+$/, '') + '/';
      if (fold(id).startsWith(fold(prefix))) { id = id.slice(prefix.length); break; }
    }
  }
  while (id.startsWith('./')) id = id.slice(2);
  return id;
}
