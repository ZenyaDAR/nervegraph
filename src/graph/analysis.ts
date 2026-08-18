import type { Graph, GraphNode, GraphEdge } from './types.ts';

// Derived facts that answer "what is wrong here", as opposed to build.ts's
// "how is this connected". Everything below reads the finished node/edge set;
// nothing here touches the filesystem.

const MODULE_RELS = new Set(['import', 'require', 'dynamic_import']);

/**
 * Fill in `deadExports`: the exports of a file that no importer ever names.
 *
 * Deliberately silent rather than wrong. The field is set only when every
 * incoming reference declares its bindings — a namespace import, a `require()`,
 * an `export * from`, or a `<script src>` means the file is used as a whole and
 * nothing can be called dead. Entrypoints and orphans are skipped too: an
 * entrypoint's exports are the public surface, and an orphan has no importers
 * to learn anything from.
 */
export function markDeadExports(nodes: Map<string, GraphNode>, edges: GraphEdge[]): void {
  const usedNames = new Map<string, Set<string>>();
  const opaque = new Set<string>();

  for (const e of edges) {
    if (!MODULE_RELS.has(e.rel)) { opaque.add(e.to); continue; }
    if (!e.names) { opaque.add(e.to); continue; }
    let used = usedNames.get(e.to);
    if (!used) { used = new Set(); usedNames.set(e.to, used); }
    for (const n of e.names) {
      if (n === '*') opaque.add(e.to);
      else used.add(n);
    }
  }

  for (const node of nodes.values()) {
    if (!node.exports?.length) continue;
    if (node.entrypoint || node.in === 0 || opaque.has(node.id)) continue;
    const used = usedNames.get(node.id) ?? new Set<string>();
    const dead = node.exports.filter(name => !used.has(name));
    if (dead.length) node.deadExports = dead;
  }
}

export interface PackageGraph {
  packages: { id: string; files: number; in: number; out: number }[];
  edges: { from: string; to: string; count: number }[];
}

/**
 * The same graph one level up: node = package, edge = "some file in A imports
 * some file in B". In a monorepo the file graph is unreadable and this one
 * isn't; it is derived, so it costs no new scanning.
 *
 * A package is any directory holding a manifest (package.json, Cargo.toml,
 * go.mod, composer.json, pyproject.toml); a file belongs to the nearest one
 * above it. Nothing is read from disk — the manifests are already nodes.
 */
const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'composer.json', 'pyproject.toml'];

export function foldToPackages(graph: Graph): PackageGraph {
  const roots = new Set<string>();
  for (const n of graph.nodes) {
    const slash = n.id.lastIndexOf('/');
    const name = slash < 0 ? n.id : n.id.slice(slash + 1);
    if (MANIFESTS.includes(name)) roots.add(slash < 0 ? '' : n.id.slice(0, slash));
  }
  // Deepest first, so a nested package wins over the repo root.
  const ordered = [...roots].sort((a, b) => b.length - a.length);

  const owner = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const n of graph.nodes) {
    const root = ordered.find(r => r === '' || n.id.startsWith(r + '/')) ?? '';
    const id = root === '' ? '(root)' : root;
    owner.set(n.id, id);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const pairs = new Map<string, number>();
  for (const e of graph.edges) {
    const from = owner.get(e.from), to = owner.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }

  const edges = [...pairs.entries()]
    .map(([key, count]) => { const [from, to] = key.split('\0'); return { from, to, count }; })
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const packages = [...counts.entries()]
    .map(([id, files]) => ({
      id, files,
      in: edges.filter(e => e.to === id).length,
      out: edges.filter(e => e.from === id).length,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { packages, edges };
}

/**
 * Files with byte-identical content, grouped. The hash is already on every
 * node, so this costs one pass — and "these three files are the same file"
 * is the cheapest deletion candidate the graph can offer.
 */
export function findDuplicates(nodes: Iterable<GraphNode>): string[][] {
  const byHash = new Map<string, string[]>();
  for (const n of nodes) {
    // Empty and binary-leaf files share the empty hash and are not duplicates
    // in any useful sense.
    if (!n.hash || n.loc === 0) continue;
    const group = byHash.get(n.hash);
    if (group) group.push(n.id); else byHash.set(n.hash, [n.id]);
  }
  return [...byHash.values()]
    .filter(group => group.length > 1)
    .map(group => group.sort())
    .sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}
