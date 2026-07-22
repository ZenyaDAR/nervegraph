import path from 'node:path';
import { collectFiles, hashContent, type ScannedFile } from '../scan/files.ts';
import { detectProfile, classifyNodeType, isEntrypoint } from '../scan/profile.ts';
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
  for (const b of binaryLeaves) {
    // present on disk but not content-scanned; may become a node if referenced
  }

  const existingIds = new Set<string>([...fileById.keys(), ...binaryLeaves.map(b => b.id)]);
  const existingLower = new Set<string>([...existingIds].map(s => s.toLowerCase()));
  function fileExists(id: string): boolean {
    return existingLower.has(id.toLowerCase());
  }
  function realId(id: string): string {
    if (existingIds.has(id)) return id;
    const lower = id.toLowerCase();
    for (const e of existingIds) if (e.toLowerCase() === lower) return e;
    return id;
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
    for (const e of outcome.edges) edges.push({ ...e, to: realId(e.to) });
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
      out: outcome.edges.length,
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
    tool: 'nervegraph@0.1.0',
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

function langFor(id: string): string {
  const ext = path.extname(id).toLowerCase();
  if (ext === '.liquid') return 'liquid';
  if (['.js', '.mjs', '.jsx'].includes(ext)) return 'javascript';
  if (['.ts', '.tsx'].includes(ext)) return 'javascript';
  if (['.css', '.scss'].includes(ext)) return 'css';
  if (ext === '.json') return 'json';
  if (ext === '.svg') return 'svg';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return 'image';
  return 'other';
}

function detectCycles(nodes: Map<string, GraphNode>, edges: GraphEdge[], warnings: Warning[]) {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from)!.push(e.to);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  let found = false;

  function dfs(u: string): boolean {
    color.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) return true;
      if (c === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  }

  for (const id of nodes.keys()) {
    if ((color.get(id) ?? WHITE) === WHITE) {
      if (dfs(id)) { found = true; break; }
    }
  }
  if (found) warnings.push({ code: 'cycle', file: '', message: 'dependency cycle detected' });
}
