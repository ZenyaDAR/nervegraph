import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import type { Graph, GraphNode, GraphEdge, Risk, UnresolvedRef } from './types.ts';
import { hotThreshold } from '../scan/git.ts';
import { parseJsonc } from '../scan/aliases.ts';

// Derived facts that answer "what is wrong here", as opposed to build.ts's
// "how is this connected". Everything below reads the finished node/edge set;
// only refineGraph() reads the filesystem (package.json and tsconfig.json).

const MODULE_RELS = new Set(['import', 'require', 'dynamic_import']);

// --- what kind of file is this ------------------------------------------------

const FIXTURE_PATH = /(^|\/)(fixtures?|__fixtures__|__mocks__|__snapshots__|testdata|test-data)\//i;
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$|_spec\.rb$|(Tests?|IT)\.(java|kt|cs)$/;
const DOC_PATH = /\.(md|mdx|markdown|rst|txt|adoc)$|(^|\/)(docs?|documentation)\/|(^|\/)(README|LICENSE|LICENCE|CHANGELOG|CONTRIBUTING|AUTHORS|NOTICE|SECURITY|CODE_OF_CONDUCT)(\.[^/]*)?$/i;
const ASSET_PATH = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mov|mp3|wav|ogg|pdf|zip)$/i;
const CONFIG_PATH = /(^|\/)\.[^/]+$|\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|lock|env|properties)$|(^|\/)[^/]+\.config\.[^/]+$|(^|\/)(Dockerfile|Makefile|Procfile|Gemfile|Rakefile|go\.sum)$|(^|\/)config\//i;
const ENTRY_PATH = /(^|\/)(bin|scripts?|cmd|tools|examples?)\/|(^|\/)(cli|server|app|main|index|run|manage|setup|start|worker|bootstrap)\.[^./]+$/;

/** A test file (not a fixture a test reads): `test/`, `*.test.*`, `test_*.py`, `*_test.go`, `*_spec.rb`, … */
export function isTestFile(id: string): boolean {
  return !FIXTURE_PATH.test(id) && TEST_PATH.test(id);
}

export type FileKind = 'test' | 'fixture' | 'doc' | 'asset' | 'config' | 'entry' | 'code';
export const FILE_KINDS: FileKind[] = ['code', 'entry', 'test', 'fixture', 'doc', 'config', 'asset'];

/**
 * Why a file might be unreferenced. Only `code` is a real deletion candidate;
 * the rest are entered from outside the import graph (a test runner, a reader,
 * a tool's config loader, a shell) or are data.
 */
export function fileKind(id: string): FileKind {
  if (FIXTURE_PATH.test(id)) return 'fixture';
  if (TEST_PATH.test(id)) return 'test';
  if (DOC_PATH.test(id)) return 'doc';
  if (ASSET_PATH.test(id)) return 'asset';
  if (CONFIG_PATH.test(id)) return 'config';
  if (ENTRY_PATH.test(id)) return 'entry';
  return 'code';
}

/** An unresolved reference that points outside the project on purpose: a package, a builtin, a URL. */
export function isExternal(u: UnresolvedRef): boolean {
  return u.reason === 'external';
}

// --- risk, entrypoints, orphans ----------------------------------------------

/**
 * Risk is about what breaks when the file changes, so it follows dependents.
 * A file everything depends on is risky; one that also changes every week is
 * riskier still (churn promotes one step, and only for a file with
 * dependents). Docs and media never break a build. An entrypoint with no
 * dependents is only as risky as what it pulls in: medium when it imports
 * something, low when it is a leaf such as a locale file.
 */
export function riskFor(n: GraphNode, hot: boolean): Risk {
  const kind = fileKind(n.id);
  if (kind === 'doc' || kind === 'asset') return 'low';
  if (n.in >= 10) return 'high';
  if (n.in >= 3) return hot ? 'high' : 'medium';
  if (n.in >= 1) return hot ? 'medium' : 'low';
  return n.entrypoint && n.out > 0 ? 'medium' : 'low';
}

/**
 * Files package.json declares as entry points (`main`, `module`, `bin`,
 * `exports`). A path under tsconfig's `outDir` is mapped back to its source
 * under `rootDir`, so `bin: dist/cli.js` marks `src/cli.ts`.
 */
export function packageEntrypoints(root: string): Set<string> {
  const ids = new Set<string>();
  const pkg = readJson(path.join(root, 'package.json'));
  if (!pkg) return ids;

  const targets: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === 'string') targets.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x);
  };
  for (const key of ['main', 'module', 'bin', 'exports']) collect(pkg[key]);

  const ts = readJson(path.join(root, 'tsconfig.json'))?.compilerOptions ?? {};
  const strip = (p: unknown) => typeof p === 'string' ? p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '') : undefined;
  const outDir = strip(ts.outDir);
  const rootDir = strip(ts.rootDir) ?? 'src';

  for (const t of targets) {
    const id = strip(t)!;
    ids.add(id);
    if (outDir && id.startsWith(outDir + '/')) {
      const src = (rootDir && rootDir !== '.' ? rootDir + '/' : '') + id.slice(outDir.length + 1);
      const stem = src.replace(/\.(c|m)?js$/, '');
      for (const ext of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']) ids.add(stem + ext);
    }
  }
  return ids;
}

function readJson(file: string): any {
  if (!existsSync(file)) return undefined;
  try { return parseJsonc(readFileSync(file, 'utf8')); } catch { return undefined; }
}

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
