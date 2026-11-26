import path from 'node:path';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { isInRepository, readGraph, prevGraphPath, projectDirOf, resolveGraphPath, writeGraphAtomic } from '../graph/io.ts';
import { buildGraph } from '../graph/build.ts';
import type { Graph, GraphNode, GraphEdge } from '../graph/types.ts';
import { foldToPackages, fileKind, isExternal, isTestFile, FILE_KINDS } from '../graph/analysis.ts';
import { listFiles } from '../scan/files.ts';

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
  /** Never re-scan; by default a missing or stale graph is re-scanned first. */
  noAutoscan?: boolean;
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

/**
 * Read the graph, re-scanning first when `autoscan` is on and the graph is
 * missing or a file it covers changed since. An agent acting on a stale graph
 * is the failure this tool exists to prevent, and "run nerve scan first" is
 * one more step it may skip. A missing graph is scanned only at the default
 * `<project>/.nervegraph/graph.json`: an explicit path to nowhere is a typo,
 * not a request to scan the working directory — and, unless
 * `scanOutsideRepo`, only inside a repository: run in a home folder or `C:\`,
 * "scan everything here" is not what a query asked for. The MCP server passes
 * it: its working directory is the project its client chose.
 * `checked` says whether the graph is known to be fresh now.
 */
export async function loadFreshGraph(graphPath: string, autoscan: boolean, opts: { scanOutsideRepo?: boolean } = {}): Promise<{ graph: Graph; checked: boolean }> {
  const plain = async () => ({ graph: await readGraph(graphPath), checked: false });
  if (!autoscan || path.basename(graphPath) !== 'graph.json') return plain();
  let graph: Graph | undefined;
  if (existsSync(graphPath)) {
    graph = await readGraph(graphPath);
    const stale = (await staleFilesAsync(graph, graphPath)).length;
    if (!stale) return { graph, checked: true };
    console.error(`nervegraph: ${stale} files changed since the scan, re-scanning`);
  } else if (path.basename(path.dirname(graphPath)) === '.nervegraph' && (opts.scanOutsideRepo || isInRepository(projectDirOf(graphPath)))) {
    console.error(`nervegraph: no graph at ${graphPath}, scanning`);
  } else {
    return plain();
  }
  const root = graph ? projectRoot(graph, graphPath) : projectDirOf(graphPath);
  // The flags of the scan being replaced: dropping them pulled --ignore'd
  // trees into the graph and rewrote a --pretty one compact.
  const flags = graph?.scan ?? {};
  // Before the scan: creating the folder after it touches the project root,
  // which the next staleness check would read as a change.
  await mkdir(path.dirname(graphPath), { recursive: true });
  const fresh = await buildGraph({
    root, profile: graph?.profile,
    extraIgnore: flags.ignore, noGitignore: flags.noGitignore, noGit: flags.noGit, classes: flags.classes,
  });
  if (flags.pretty) fresh.scan = { ...fresh.scan, pretty: true };
  await writeGraphAtomic(path.dirname(graphPath), fresh, flags.pretty);
  return { graph: fresh, checked: true };
}

export async function runQuery(args: QueryArgs): Promise<number> {
  const graphPath = resolveGraphPath(args.graph);
  const { graph } = await loadFreshGraph(graphPath, !args.noAutoscan);
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

/**
 * The directory the graph's ids are relative to, on this machine. The
 * recorded root wins while the graph sits inside it (`scan --out` anywhere in
 * the project). A graph at `<dir>/.nervegraph/` outside its recorded root was
 * copied or committed — a second checkout, a worktree — and belongs to `<dir>`:
 * trusting the recorded root re-scanned the other checkout.
 * shortcut: `nerve scan ../proj --out .nervegraph` (a graph outside the tree it
 * scanned, in a folder named .nervegraph) now reads as the cwd's project; record
 * the graph's own location relative to root if anyone does that.
 */
export function projectRoot(graph: Graph, graphPath?: string): string {
  if (!graphPath) return graph.root;
  const fold = (p: string) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  const inside = fold(graphPath).startsWith(fold(graph.root) + path.sep);
  if (existsSync(graph.root) && (inside || path.basename(path.dirname(path.resolve(graphPath))) !== '.nervegraph')) return graph.root;
  return projectDirOf(graphPath);
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
  // Grouped by node type, "which sections / templates / JS modules does this
  // reach" is one key to read, not a list to re-check with grep. usedBy
  // already names the direct dependents, so only the rest is listed here.
  const typeOf = new Map(graph.nodes.map(n => [n.id, n.type]));
  const direct = new Set((adj.incoming.get(node.id) ?? []).map(e => e.from));
  // Capped per type: one cap over all of them let 50 blocks crowd out every JS module.
  const indirectByType: Record<string, string[]> = {};
  for (const d of dependents) if (!direct.has(d)) (indirectByType[typeOf.get(d) ?? 'unknown'] ??= []).push(d);
  for (const type of Object.keys(indirectByType).sort()) {
    const files = indirectByType[type];
    delete indirectByType[type];
    indirectByType[type] = cap(files, limit, `indirectDependents.${type}`, truncated);
  }
  const affectedByType: Record<string, number> = {};
  for (const d of dependents) affectedByType[typeOf.get(d) ?? 'unknown'] = (affectedByType[typeOf.get(d) ?? 'unknown'] ?? 0) + 1;

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
    // Every dependent, direct or not, counted by node type.
    affectedByType: Object.fromEntries(Object.entries(affectedByType).sort((a, b) => b[1] - a[1] || cmpStr(a[0], b[0]))),
    indirectDependents: indirectByType,
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
  return fileChangedSince(projectRoot(graph, graphPath), node.id, new Date(graph.scannedAt).getTime());
}

// A timestamp in the future (an archive extracted with its dates, clock skew on
// a network drive) proves nothing, and counting it re-scanned on every call.
// Editing such a file sets it to now, which counts again.
const after = (t: number, since: number) => t > since && t <= Date.now();

function fileChangedSince(root: string, id: string, since: number): boolean {
  try {
    return after(statSync(path.join(root, id)).mtimeMs, since);
  } catch {
    return true; // the file is gone since the scan, which is the staler case
  }
}

function staleContext(graph: Graph, graphPath?: string) {
  const root = projectRoot(graph, graphPath);
  const since = new Date(graph.scannedAt).getTime();
  // The scan's own output can sit inside the project (--out) and is always newer.
  // Windows spells one drive as C: or c: depending on who asks.
  const key = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const own = new Set(graphPath ? [graphPath, prevGraphPath(graphPath), walkedPath(graphPath)].map(key) : []);
  const isOwn = (id: string) => own.has(key(path.join(root, id)));
  const known = new Set(graph.nodes.filter(n => !n.missing).map(n => n.id));
  return { root, since, isOwn, known, check: [...known].filter(id => !isOwn(id)), graphPath };
}

// When the last full walk found nothing new, next to graph.json: directories
// touched before it are known to hold nothing new. Without it, one unrelated
// write in the root (npm install, a log) made every query walk the whole tree
// until the next re-scan.
const walkedPath = (graphPath: string) => path.join(path.dirname(graphPath), 'walked');
function walkedAt(graphPath?: string): number {
  if (!graphPath) return 0;
  try { return Number(readFileSync(walkedPath(graphPath), 'utf8')) || 0; } catch { return 0; }
}

/** Files on disk that changed, vanished or appeared since the scan. */
export function staleFiles(graph: Graph, graphPath?: string): string[] {
  const ctx = staleContext(graph, graphPath);
  return staleWith(graph, ctx, ctx.check.filter(id => fileChangedSince(ctx.root, id, ctx.since)));
}

/**
 * staleFiles with the per-file stats in parallel: on Windows 30k stats take
 * 1.5 s one after another and 0.45 s sixteen at a time — and this runs before
 * every agent query.
 */
export async function staleFilesAsync(graph: Graph, graphPath?: string): Promise<string[]> {
  const ctx = staleContext(graph, graphPath);
  const changed: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (next < ctx.check.length) {
      const id = ctx.check[next++];
      try {
        if (after((await stat(path.join(ctx.root, id))).mtimeMs, ctx.since)) changed.push(id);
      } catch {
        changed.push(id); // gone since the scan
      }
    }
  }));
  return staleWith(graph, ctx, changed.sort());
}

function staleWith(graph: Graph, ctx: ReturnType<typeof staleContext>, changed: string[]): string[] {
  const { root, since, isOwn, known, graphPath } = ctx;
  if (!existsSync(root)) return changed;
  const dirsSince = Math.max(since, walkedAt(graphPath));
  // Adding, removing or renaming a file touches its directory, so the full
  // walk (2+ s on 30k files, on every query) is needed only when one of the
  // known files' directories, or a .gitignore in one, changed.
  // shortcut: misses a file added under a directory that holds no scanned file
  // (only subdirectories or ignored files); walk always if that shows up.
  const dirs = new Set<string>(['']);
  for (const id of known) for (let i = id.indexOf('/'); i >= 0; i = id.indexOf('/', i + 1)) dirs.add(id.slice(0, i));
  const touched = (rel: string) => { try { return after(statSync(path.join(root, rel)).mtimeMs, dirsSince); } catch { return false; } };
  if (![...dirs].some(d => touched(d) || touched(path.join(d, '.gitignore')))) return changed;
  const walkStart = Date.now();
  const { relevant, gitignores } = listFiles(root, { skipIgnoredDirs: true, extraIgnore: graph.scan?.ignore, noGitignore: graph.scan?.noGitignore });
  // Not a node, but editing a .gitignore changes which files the graph covers.
  const unknown = [...relevant, ...gitignores];
  const added = unknown.filter(id => !known.has(id) && !isOwn(id) && addedSince(root, id, since));
  if (!added.length && graphPath) {
    try { writeFileSync(walkedPath(graphPath), String(walkStart)); } catch { /* read-only checkout: walk again next time */ }
  }
  return [...changed, ...added];
}

// A copied or moved-in file keeps its old mtime. One the scan was told to skip
// (--ignore) is absent from the graph too, so absence alone proves nothing.
// shortcut: misses a whole directory moved in (its files keep every timestamp)
// and a deleted .gitignore; store the scan's file list in the graph to catch both.
function addedSince(root: string, id: string, since: number): boolean {
  try {
    const st = statSync(path.join(root, id));
    return after(Math.max(st.mtimeMs, st.ctimeMs, st.birthtimeMs), since);
  } catch {
    return false;
  }
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
      // External references (packages, builtins, URLs) are expected, and on a
      // real project they outnumber the genuine ones 100 to 1: listed by
      // default they filled the whole answer. Counted always, listed on --all.
      const genuine = graph.unresolved.filter(u => !isExternal(u));
      const external = graph.unresolved.filter(isExternal);
      return {
        key: 'unresolved', rows: opts.all ? [...genuine, ...external] : genuine,
        extra: { external: external.length, genuine: genuine.length, ...(opts.all || !external.length ? {} : { hint: 'external references not listed; all: true / --all lists them' }) },
      };
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
  const unknown = !exportedBy.length && !importedBy.length;
  if (unknown) {
    const want = name.toLowerCase();
    const budget = typoBudget(want);
    const names = new Set<string>();
    for (const n of graph.nodes) {
      for (const x of n.exports ?? []) {
        const low = x.toLowerCase();
        if (low.includes(want) || editDistance(low, want, budget) <= budget) names.add(x);
      }
    }
    similar = [...names].sort().slice(0, 10);
  }
  return {
    symbol: name,
    exportedBy: cap(exportedBy, limit, 'exportedBy', truncated),
    importedBy: cap(importedBy, limit, 'importedBy', truncated),
    counts: { exportedBy: exportedBy.length, importedBy: importedBy.length, viaNamespace: viaNamespace.length },
    ...(viaNamespace.length ? { viaNamespace: cap(viaNamespace, limit, 'viaNamespace', truncated) } : {}),
    ...(similar?.length ? { similar } : {}),
    // An empty answer must not read as "nothing uses it".
    ...(unknown ? { note: 'No file exports or imports this name. Only module exports and the names an import binds are tracked; a local function, a method, a global or a string lookup is not — search the source for it.' } : {}),
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}

/** How many edits still count as a typo: none for a name of 1–2 characters, where every name is two edits away. */
export const typoBudget = (name: string) => (name.length >= 6 ? 2 : name.length >= 3 ? 1 : 0);

/** Levenshtein distance, giving up (returning max + 1) once it exceeds `max`. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Code-unit order: the same on every machine, unlike localeCompare.
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function printSymbol(r: ReturnType<typeof symbolReport>): void {
  const lines = [r.symbol];
  if (r.note) {
    lines.push(`  ${r.note}`);
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
  const byType = Object.entries(card.affectedByType);
  if (byType.length) lines.push(`  reaches   ${byType.map(([t, n]) => `${n} ${t}`).join(' · ')}`);
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
  const indirect = Object.entries(card.indirectDependents);
  if (indirect.length && !('dependents' in card)) {
    lines.push('', '  indirect dependents');
    for (const [type, files] of indirect) {
      const more = card.truncated?.[`indirectDependents.${type}`];
      lines.push(`    ${type}: ${files.join(', ')}${more ? ` … ${more} more (--limit 0 lists all)` : ''}`);
    }
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
  /** Nothing matched: the files inside a directory of that name, or near-miss names. */
  suggestions?: { directory: boolean; files: string[] };
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
  return { query, candidates: found, ...(query && !found.length ? { suggestions: suggest(graph, query) } : {}) };
}

/** A directory's files, or the ids whose file name is a typo away from the typed one. */
function suggest(graph: Graph, query: string): { directory: boolean; files: string[] } {
  const want = query.toLowerCase().replace(/\/+$/, '');
  const inDir = graph.nodes.filter(n => !n.missing && n.id.toLowerCase().startsWith(want + '/')).map(n => n.id);
  if (inDir.length) return { directory: true, files: inDir };
  const name = stripExt(basename(want));
  const budget = Math.max(1, typoBudget(name));
  // In a big repo a short name has thousands of near misses: the typed directory's come first.
  const dir = want.includes('/') ? want.slice(0, want.lastIndexOf('/') + 1) : '';
  const elsewhere = (id: string) => (dir && id.toLowerCase().startsWith(dir) ? 0 : 1);
  const near = graph.nodes
    .map(n => ({ id: n.id, d: editDistance(stripExt(basename(n.id)).toLowerCase(), name, budget) }))
    .filter(x => x.d <= budget)
    .sort((a, b) => elsewhere(a.id) - elsewhere(b.id) || a.d - b.d || cmpStr(a.id, b.id));
  return { directory: false, files: near.slice(0, 5).map(x => x.id) };
}

/** Why a lookup did not land on one node, with what to pass instead. */
export function lookupFailureMessage(found: NodeLookup): string {
  const list = (ids: string[]) => ids.slice(0, 20).map(id => `  ${id}`).join('\n') + (ids.length > 20 ? `\n  … ${ids.length - 20} more` : '');
  if (found.candidates.length) return `${found.query} matches ${found.candidates.length} files; pass one of these paths:\n${list(found.candidates.map(n => n.id))}`;
  const s = found.suggestions;
  if (s?.directory) return `${found.query} is a directory of ${s.files.length} files; query one file (or use depth / the list tool):\n${list(s.files)}`;
  if (s?.files.length) return `${found.query} is not in the graph. Did you mean:\n${list(s.files)}`;
  return `${found.query} is not in the graph. Paths are relative to the scanned root; a re-scan picks up new files.`;
}

/** Print why a lookup did not land on one node, to stderr. */
export function reportLookupFailure(found: NodeLookup): void {
  console.error(`error: ${lookupFailureMessage(found)}`);
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
