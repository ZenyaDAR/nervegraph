import path from 'node:path';
import { collectFiles, hashContent, type ScannedFile } from '../scan/files.ts';
import { detectProfile, classifyNodeType, isEntrypoint } from '../scan/profile.ts';
import { langFor } from '../scan/extensions.ts';
import { VERSION } from '../version.ts';
import { findLanguage } from '../scan/languages/index.ts';
import { resolveRefs } from './resolve.ts';
import type { Graph, GraphNode, GraphEdge, UnresolvedRef, Warning, RawRef, Risk } from './types.ts';
import { SCHEMA_VERSION } from './types.ts';
import { readFileSync, existsSync } from 'node:fs';

export interface ScanOptions {
  root: string;
  profile?: string;
  extraIgnore?: string[];
  noGitignore?: boolean;
  classes?: boolean;
}

function countLoc(content: string): number {
  if (content.length === 0) return 0;
  return content.split('\n').length;
}

function riskFor(inDeg: number, entrypoint: boolean): Risk {
  if (entrypoint) return 'high';
  if (inDeg >= 10) return 'high';
  if (inDeg >= 3) return 'medium';
  return 'low';
}

export async function buildGraph(opts: ScanOptions): Promise<Graph> {
  const start = Date.now();
  const root = opts.root;
  const { profile, warning: profileWarning } = detectProfile(root, opts.profile);

  const { files, tooLarge, readErrors, binaryLeaves } = await collectFiles(root, {
    extraIgnore: opts.extraIgnore,
    noGitignore: opts.noGitignore,
  });

  const warnings: Warning[] = [];
  if (profileWarning) warnings.push({ code: 'parse_error', file: '', message: profileWarning });
  for (const f of tooLarge) warnings.push({ code: 'file_too_large', file: f, message: 'file exceeds 2MB, skipped' });
  for (const e of readErrors) warnings.push({ code: 'read_error', file: e.file, message: e.message });

  let pkg: any;
  const pkgPath = path.join(root, 'package.json');
  if (profile === 'js' && existsSync(pkgPath)) {
    try { pkg = JSON.parse(readFileSync(pkgPath, 'utf8')); } catch { /* ignore */ }
  }

  const fileById = new Map<string, ScannedFile>();
  for (const f of files) fileById.set(f.id, f);

  // Binary leaves are on disk but never content-scanned; they only become
  // nodes if something references them (or below, unconditionally as leaves).
  const existingIds = new Set<string>([...fileById.keys(), ...binaryLeaves.map(b => b.id)]);
  // Case-insensitive index built once. Resolving a reference whose case
  // doesn't match the file on disk used to scan every id, making a
  // case-sloppy repo O(files x refs).
  const byLowerId = new Map<string, string>();
  for (const id of existingIds) byLowerId.set(id.toLowerCase(), id);

  function fileExists(id: string): boolean {
    return byLowerId.has(id.toLowerCase());
  }
  function realId(id: string): string {
    return byLowerId.get(id.toLowerCase()) ?? id;
  }

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const unresolved: UnresolvedRef[] = [];
  const missingIds = new Set<string>();

  let defaultLocale: string | undefined;
  for (const id of existingIds) {
    if (/^locales\/.*\.default\.json$/.test(id)) { defaultLocale = id; break; }
  }

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
      } catch {
        warnings.push({ code: 'parse_error', file: file.id, message: `invalid ${lang.id}` });
      }
    }

    const outcome = resolveRefs(file.id, refs, { profile, fileExists, defaultLocale });
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

  for (const n of nodes.values()) {
    n.risk = riskFor(n.in, n.entrypoint);
    n.orphan = n.in === 0 && !n.entrypoint;
  }

  detectCycles(nodes, edges, warnings);

  const sortedNodes = [...nodes.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sortedEdges = [...edges].sort((a, b) =>
    a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.rel.localeCompare(b.rel) || a.line - b.line);
  const sortedUnresolved = [...unresolved].sort((a, b) =>
    a.from.localeCompare(b.from) || a.line - b.line);

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
    warnings,
  };

  return graph;
}

/**
 * Drop references that land on the same target, relation *and* line. One
 * source line can legitimately yield several refs to one file — `from pkg
 * import a, b` is the common case — and they'd otherwise show up as parallel
 * edges the viewer draws on top of each other.
 */
function dedupeEdges(list: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return list.filter(e => {
    const key = `${e.to}\0${e.rel}\0${e.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Report dependency cycles, naming the files involved — "dependency cycle
 * detected" with no location left the user grepping by hand.
 *
 * Iterative rather than recursive: a deep import chain (a 10k-file monorepo
 * barrel) overflowed the call stack, which crashed the whole scan.
 */
function detectCycles(nodes: Map<string, GraphNode>, edges: GraphEdge[], warnings: Warning[]) {
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
}

// A tangled project can contain thousands of cycles; past a handful the list
// stops being actionable and just bloats graph.json.
const MAX_REPORTED_CYCLES = 20;
