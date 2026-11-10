import path from 'node:path';
import { collectFiles, hashContent, type ScannedFile } from '../scan/files.ts';
import { detectProfile, classifyNodeType, isEntrypoint } from '../scan/profile.ts';
import { langFor } from '../scan/extensions.ts';
import { VERSION } from '../version.ts';
import { findLanguage } from '../scan/languages/index.ts';
import { loadAliases, loadGoModules, loadPsr4 } from '../scan/aliases.ts';
import { resolveRefs } from './resolve.ts';
import { markDeadExports, findDuplicates, packageEntrypoints, riskFor } from './analysis.ts';
import { collectChurn, hotThreshold } from '../scan/git.ts';
import type { Graph, GraphNode, GraphEdge, UnresolvedRef, Warning, RawRef, Risk } from './types.ts';
import { SCHEMA_VERSION } from './types.ts';
import { readFileSync, existsSync } from 'node:fs';

export interface ScanOptions {
  root: string;
  profile?: string;
  extraIgnore?: string[];
  noGitignore?: boolean;
  classes?: boolean;
  noGit?: boolean;
}

function countLoc(content: string): number {
  if (content.length === 0) return 0;
  // A file's final newline terminates its last line, it doesn't start a new
  // one — splitting without stripping it counted an extra line for every
  // conventionally-terminated source file.
  return content.replace(/\n$/, '').split('\n').length;
}

export async function buildGraph(opts: ScanOptions): Promise<Graph> {
  const start = Date.now();
  const root = opts.root;
  const { profile, warning: profileWarning } = detectProfile(root, opts.profile);

  const { files, tooLarge, readErrors, binaryLeaves, ignored } = await collectFiles(root, {
    extraIgnore: opts.extraIgnore,
    noGitignore: opts.noGitignore,
  });

  const warnings: Warning[] = [];
  if (profileWarning) warnings.push({ code: 'parse_error', file: '', message: profileWarning });
  for (const f of tooLarge) warnings.push({ code: 'file_too_large', file: f, message: 'file exceeds 2MB, skipped' });
  for (const e of readErrors) warnings.push({ code: 'read_error', file: e.file, message: e.message });

  let pkg: any;
  const pkgPath = path.join(root, 'package.json');
  if (profile !== 'shopify' && existsSync(pkgPath)) {
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }
  }

  const aliases = loadAliases(root);
  const psr4 = loadPsr4(root);

  const fileById = new Map<string, ScannedFile>();
  for (const f of files) fileById.set(f.id, f);

  // Binary leaves are on disk but never content-scanned; they only become
  // nodes if something references them (or below, unconditionally as leaves).
  // Ignored files are on disk too: never scanned, but an import of one is not
  // a "missing" file — it becomes a leaf node only if something references it.
  const existingIds = new Set<string>([...fileById.keys(), ...binaryLeaves.map(b => b.id), ...ignored]);
  const goModules = loadGoModules(root, existingIds);
  // Case-insensitive index built once. Resolving a reference whose case
  // doesn't match the file on disk used to scan every id, making a
  // case-sloppy repo O(files x refs).
  // On a case-sensitive filesystem `src/Utils.js` and `src/utils.js` are two
  // different files sharing one lowercased key. First writer wins, and the
  // collision is recorded so realId() leaves those ids alone rather than
  // rewriting every reference onto whichever file happened to be indexed.
  const byLowerId = new Map<string, string>();
  const ambiguousLowerIds = new Set<string>();
  for (const id of existingIds) {
    const key = id.toLowerCase();
    const seen = byLowerId.get(key);
    if (seen === undefined) byLowerId.set(key, id);
    else if (seen !== id) ambiguousLowerIds.add(key);
  }

  function fileExists(id: string): boolean {
    return byLowerId.has(id.toLowerCase());
  }
  // Directory -> the ids directly inside it. Built once: a Go package import
  // or a Terraform module source names a directory, and scanning every id per
  // reference to find its contents would be quadratic.
  const dirIndex = new Map<string, string[]>();
  for (const id of existingIds) {
    const slash = id.lastIndexOf('/');
    const dir = slash < 0 ? '' : id.slice(0, slash);
    const list = dirIndex.get(dir);
    if (list) list.push(id); else dirIndex.set(dir, [id]);
  }
  function listDir(dir: string): string[] {
    return dirIndex.get(dir) ?? [];
  }

  function realId(id: string): string {
    const key = id.toLowerCase();
    if (ambiguousLowerIds.has(key)) return id;
    return byLowerId.get(key) ?? id;
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const unresolved: UnresolvedRef[] = [];
  const missingIds = new Set<string>();

  let defaultLocale: string | undefined;
  for (const id of existingIds) {
    if (/^locales\/.*\.default\.json$/.test(id)) { defaultLocale = id; break; }
  }

  // Custom elements are resolved by name against the whole project, not by
  // path, so they wait for every file to have been scanned. `files` is sorted
  // by id, so when two files define one tag the winner is stable.
  const elementDefinedIn = new Map<string, string>();
  const elementRefs: { from: string; ref: RawRef }[] = [];

  for (const file of files) {
    const lang = findLanguage(file.id, { profile });
    let refs: RawRef[] = [];
    let exportsList: string[] | undefined;
    let classesList: string[] | undefined;

    if (lang) {
      try {
        const r = lang.scan(file, { profile });
        refs = r.refs;
        exportsList = r.exports;
        classesList = opts.classes ? r.classes : undefined;
        for (const tag of r.defines ?? []) {
          if (!elementDefinedIn.has(tag)) elementDefinedIn.set(tag, file.id);
        }
      } catch {
        warnings.push({ code: 'parse_error', file: file.id, message: `invalid ${lang.id}` });
      }
    }

    for (const ref of refs) if (ref.rel === 'custom_element') elementRefs.push({ from: file.id, ref });
    refs = refs.filter(r => r.rel !== 'custom_element');

    const outcome = resolveRefs(file.id, refs, { profile, fileExists, defaultLocale, aliases, psr4, goModules, listDir });
    for (const e of outcome.edges) {
      if (outcome.missingTargets.has(e.to) || existingIds.has(e.to) || realId(e.to) === e.to) continue;
      // Resolved only because the lookup ignores case: works on macOS and
      // Windows, breaks on a Linux CI.
      warnings.push({
        code: 'case_mismatch', file: file.id,
        message: `line ${e.line}: "${e.raw}" matches ${realId(e.to)} only case-insensitively (breaks on case-sensitive filesystems)`,
      });
    }
    const fileEdges = dedupeEdges(outcome.edges.map(e => ({ ...e, to: realId(e.to) })));
    edges.push(...fileEdges);
    unresolved.push(...outcome.unresolved);
    for (const m of outcome.missingTargets) missingIds.add(m);

    nodes.set(file.id, {
      id: file.id,
      type: classifyNodeType(file.id, profile),
      lang: langFor(file.id),
      size: file.size,
      loc: countLoc(file.content),
      hash: hashContent(file.content),
      in: 0,
      out: fileEdges.length,
      risk: 'low',
      orphan: false,
      entrypoint: isEntrypoint(file.id, profile, pkg),
      ...(exportsList ? { exports: exportsList } : {}),
      ...(classesList ? { classes: classesList } : {}),
    });
  }

  // Second pass: <product-form> in markup meets customElements.define() in JS.
  // An element nothing defines is not a mistake — it may come from a vendor
  // bundle or the platform — so it is recorded as unresolved, not as missing.
  for (const { from, ref } of elementRefs) {
    const target = elementDefinedIn.get(ref.target);
    if (target && target !== from) {
      edges.push({ from, to: target, rel: 'custom_element', line: ref.line, raw: ref.raw, value: ref.target });
      const node = nodes.get(from);
      if (node) node.out += 1;
    } else if (!target) {
      unresolved.push({
        from, line: ref.line, rel: 'custom_element', raw: ref.raw,
        reason: 'ambiguous', hint: 'no customElements.define() for this tag in the project',
      });
    }
  }

  for (const b of binaryLeaves) {
    if (!nodes.has(b.id)) {
      nodes.set(b.id, {
        id: b.id,
        type: classifyNodeType(b.id, profile),
        lang: langFor(b.id),
        size: b.size,
        loc: 0,
        hash: '',
        in: 0,
        out: 0,
        risk: 'low',
        orphan: false,
        entrypoint: isEntrypoint(b.id, profile, pkg),
      });
    }
  }

  // Ignored files someone references: leaves like a binary, never scanned.
  const ignoredSet = new Set(ignored);
  for (const e of edges) {
    if (!ignoredSet.has(e.to) || nodes.has(e.to)) continue;
    nodes.set(e.to, {
      id: e.to,
      type: classifyNodeType(e.to, profile),
      lang: langFor(e.to),
      size: 0,
      loc: 0,
      hash: '',
      in: 0,
      out: 0,
      risk: 'low',
      orphan: false,
      entrypoint: false,
    });
  }

  for (const id of missingIds) {
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        type: classifyNodeType(id, profile),
        lang: langFor(id),
        size: 0,
        loc: 0,
        hash: '',
        in: 0,
        out: 0,
        risk: 'low',
        orphan: false,
        entrypoint: false,
        missing: true,
      });
    }
  }

  for (const e of edges) {
    const target = nodes.get(e.to);
    if (target) target.in += 1;
  }

  const churn = opts.noGit ? new Map<string, number>() : collectChurn(root);
  const hotAt = hotThreshold(churn);

  // package.json main/bin/exports (mapped dist → src) are entrypoints too.
  const pkgEntries = profile === 'shopify' ? new Set<string>() : packageEntrypoints(root);
  for (const n of nodes.values()) {
    const commits = churn.get(n.id);
    if (commits !== undefined) n.churn = commits;
    if (!n.missing && pkgEntries.has(n.id)) n.entrypoint = true;
    n.risk = riskFor(n, (commits ?? 0) >= hotAt);
    n.orphan = n.in === 0 && !n.entrypoint && !n.missing;
  }

  markDeadExports(nodes, edges);
  const cycles = detectCycles(nodes, edges, warnings);
  const duplicates = findDuplicates(nodes.values());

  const sortedNodes = [...nodes.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Plain code-unit comparison, not localeCompare: the order must not depend
  // on the machine's locale/ICU data, or two scans of one tree would differ.
  const sortedEdges = [...edges].sort((a, b) =>
    cmp(a.from, b.from) || cmp(a.to, b.to) || cmp(a.rel, b.rel) || a.line - b.line || cmp(a.raw, b.raw));
  const sortedUnresolved = [...unresolved].sort((a, b) =>
    cmp(a.from, b.from) || a.line - b.line || cmp(a.rel, b.rel) || cmp(a.raw, b.raw));
  const sortedWarnings = [...warnings].sort((a, b) =>
    cmp(a.code, b.code) || cmp(a.file, b.file) || cmp(a.message, b.message));

  const byType: Record<string, number> = {};
  for (const n of sortedNodes) byType[n.type] = (byType[n.type] ?? 0) + 1;

  const orphanCount = sortedNodes.filter(n => n.orphan).length;

  const graph: Graph = {
    schemaVersion: SCHEMA_VERSION,
    tool: `nervegraph@${VERSION}`,
    root,
    profile,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - start,
    stats: {
      files: sortedNodes.length,
      edges: sortedEdges.length,
      unresolved: sortedUnresolved.length,
      orphans: orphanCount,
      byType,
    },
    nodes: sortedNodes,
    edges: sortedEdges,
    unresolved: sortedUnresolved,
    warnings: sortedWarnings,
    cycles,
    duplicates,
  };

  return graph;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}


/**
 * Collapse references that land on the same target, relation *and* line. One
 * source line can legitimately yield several refs to one file — `from pkg
 * import a, b` is the common case — and they'd otherwise show up as parallel
 * edges the viewer draws on top of each other. Their imported `names` are
 * merged, so `a` and `b` both still count as used.
 */
function dedupeEdges(list: GraphEdge[]): GraphEdge[] {
  const byKey = new Map<string, GraphEdge>();
  for (const e of list) {
    const key = `${e.to}\0${e.rel}\0${e.line}`;
    const first = byKey.get(key);
    if (!first) { byKey.set(key, e); continue; }
    let names: string[] | undefined;
    if (first.names && e.names) {
      names = first.names.includes('*') || e.names.includes('*') ? ['*'] : [...new Set([...first.names, ...e.names])];
    }
    // Either side not saying what it binds makes the merged edge opaque too.
    const { names: _drop, ...rest } = first;
    byKey.set(key, names ? { ...rest, names } : rest);
  }
  return [...byKey.values()];
}

/**
 * Report dependency cycles, naming the files involved — "dependency cycle
 * detected" with no location left the user grepping by hand.
 *
 * Returns them as data (`[a, b, c, a]`); the prose warning is still emitted so
 * a schema-3 consumer that only knows `warnings` keeps working.
 *
 * Iterative rather than recursive: a deep import chain (a 10k-file monorepo
 * barrel) overflowed the call stack, which crashed the whole scan.
 */
function detectCycles(nodes: Map<string, GraphNode>, edges: GraphEdge[], warnings: Warning[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const cycles: string[][] = [];

  for (const root of nodes.keys()) {
    if ((color.get(root) ?? WHITE) !== WHITE) continue;
    // Explicit stack of (node, index of next neighbour to visit) plus the
    // current DFS path, so a back-edge can name the cycle it closes.
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    const path: string[] = [root];
    color.set(root, GRAY);

    while (stack.length) {
      const top = stack[stack.length - 1];
      const neighbours = adj.get(top.id) ?? [];
      if (top.next >= neighbours.length) {
        color.set(top.id, BLACK);
        stack.pop();
        path.pop();
        continue;
      }
      const v = neighbours[top.next++];
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        const start = path.lastIndexOf(v);
        if (start >= 0 && cycles.length < MAX_REPORTED_CYCLES) cycles.push([...path.slice(start), v]);
        continue;
      }
      if (c === WHITE) {
        color.set(v, GRAY);
        stack.push({ id: v, next: 0 });
        path.push(v);
      }
    }
  }

  for (const cycle of cycles) {
    warnings.push({ code: 'cycle', file: cycle[0], message: `dependency cycle: ${cycle.join(' -> ')}` });
  }
  return cycles;
}

// A tangled project can contain thousands of cycles; past a handful the list
// stops being actionable and just bloats graph.json.
const MAX_REPORTED_CYCLES = 20;
