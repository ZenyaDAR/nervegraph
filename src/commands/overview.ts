import path from 'node:path';
import { readGraph } from '../graph/io.ts';
import type { Graph, GraphNode } from '../graph/types.ts';
import { fileKind, isExternal } from '../graph/analysis.ts';
import { sortKinds, staleFiles, toJson } from './query.ts';

// One call that answers "how is this project laid out" — the question an agent
// landing in an unfamiliar repo asks first, and the one no single query could
// answer. Kept to about a kilobyte: counts and a few names, never full lists.

const TOP = 5;

export function overview(graph: Graph, graphPath?: string) {
  const files = graph.nodes.filter(n => !n.missing);
  const top = (pick: (n: GraphNode) => number) => [...files]
    .filter(n => pick(n) > 0)
    .sort((a, b) => pick(b) - pick(a) || a.id.localeCompare(b.id))
    .slice(0, TOP)
    .map(n => [n.id, pick(n)] as [string, number]);

  const orphanKinds: Record<string, number> = {};
  for (const n of files) if (n.orphan) { const k = fileKind(n.id); orphanKinds[k] = (orphanKinds[k] ?? 0) + 1; }

  const external = graph.unresolved.filter(isExternal).length;
  // A README or a test fixture the scanner treats as an entry is not where the project starts.
  const entrypoints = files.filter(n => n.entrypoint && !['doc', 'asset', 'fixture', 'test'].includes(fileKind(n.id))).map(n => n.id);
  // Unreferenced files that look like something run directly (bin/, scripts/, cli.*).
  const likelyEntries = files.filter(n => n.orphan && fileKind(n.id) === 'entry').map(n => n.id);
  const hubs = top(n => n.in);

  return {
    project: path.basename(graph.root),
    profile: graph.profile,
    files: files.length,
    edges: graph.edges.length,
    languages: counted(files.map(n => n.lang), 8),
    kinds: counted(files.map(n => n.type), 8),
    folders: counted(files.map(n => folderOf(n.id)), 8),
    entrypoints: entrypoints.slice(0, 8),
    ...(entrypoints.length > 8 ? { moreEntrypoints: entrypoints.length - 8 } : {}),
    ...(likelyEntries.length ? { likelyEntries: likelyEntries.slice(0, TOP) } : {}),
    // [file, count]: hubs by dependents (what breaks most), fanOut by dependencies.
    hubs,
    fanOut: top(n => n.out),
    issues: {
      cycles: graph.cycles.length,
      missing: graph.nodes.length - files.length,
      orphans: sortKinds(orphanKinds),
      unresolved: graph.unresolved.length - external,
      external,
    },
    scannedAt: graph.scannedAt,
    scanMs: graph.durationMs,
    stale: graphPath ? staleFiles(graph, graphPath).length : 0,
    next: nextSteps(graph, hubs[0]?.[0]),
  };
}

/** Values with counts, most common first; the tail folded into `(rest)`. */
function counted(values: string[], max: number): Record<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out = Object.fromEntries(sorted.slice(0, max));
  const rest = sorted.slice(max).reduce((s, [, n]) => s + n, 0);
  if (rest) out['(rest)'] = rest;
  return out;
}

/** Top-level folder, or the second level under a conventional source root. */
function folderOf(id: string): string {
  const parts = id.split('/');
  if (parts.length === 1) return '.';
  if (parts.length > 2 && ['src', 'lib', 'app', 'packages', 'apps'].includes(parts[0])) return `${parts[0]}/${parts[1]}`;
  return parts[0];
}

function nextSteps(graph: Graph, hub?: string): string[] {
  const exported = graph.nodes.find(n => n.id === hub)?.exports?.[0];
  return [
    `nerve query ${hub ?? '<file>'} --json  (dependents, deps, tests)`,
    `nerve query --symbol ${exported ?? '<name>'} --json  (where exported/imported)`,
    'nerve query --changed --json  (git changes + dependents + tests)',
  ];
}

export async function runOverview(args: { graph?: string; json?: boolean; pretty?: boolean }): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');
  const o = overview(await readGraph(graphPath), graphPath);
  if (args.json) { console.log(toJson(o, args.pretty)); return 0; }

  const pairs = (r: Record<string, number>) => Object.entries(r).map(([k, n]) => `${k} ${n}`).join(' · ');
  const lines = [
    `${o.project} · ${o.profile} · ${o.files} files · ${o.edges} edges`,
    `  languages   ${pairs(o.languages)}`,
    `  kinds       ${pairs(o.kinds)}`,
    `  folders     ${pairs(o.folders)}`,
    `  entrypoints ${o.entrypoints.join(', ') || '—'}${o.moreEntrypoints ? ` (+${o.moreEntrypoints})` : ''}`,
  ];
  if (o.likelyEntries) lines.push(`  run directly ${o.likelyEntries.join(', ')}`);
  lines.push(`  hubs        ${o.hubs.map(([f, n]) => `${f} ←${n}`).join(', ') || '—'}`);
  lines.push(`  fan-out     ${o.fanOut.map(([f, n]) => `${f} →${n}`).join(', ') || '—'}`);
  const i = o.issues;
  lines.push(`  issues      ${i.cycles} cycles · ${i.missing} missing · ${i.unresolved} unresolved (+${i.external} external) · orphans: ${pairs(i.orphans) || '0'}`);
  lines.push(`  scanned     ${o.scannedAt} in ${o.scanMs} ms${o.stale ? ` · ⚠ ${o.stale} files changed since — run: nerve scan` : ''}`);
  lines.push('', '  next', ...o.next.map(s => `    ${s}`));
  console.log(lines.join('\n'));
  return 0;
}

/**
 * A snippet for CLAUDE.md / AGENTS.md: the commands an agent should reach for
 * and the project facts worth knowing before the first edit.
 */
export function agentsMd(graph: Graph): string {
  const o = overview(graph);
  const code = (s: string) => `\`${s}\``;
  return [
    '## Code map (nervegraph)',
    '',
    'A dependency graph of this repo lives in `.nervegraph/graph.json`. Do not `cat` or read it whole — it is large; query it instead:',
    '',
    '- `npx nervegraph overview` — layout, entrypoints, hubs, issue counts',
    '- `npx nervegraph query <file> --json` — `usedBy` (what breaks), `uses`, `tests` that reach it; `stale: true` means re-scan',
    '- `npx nervegraph query --symbol <name> --json` — where a symbol is exported and every import site',
    '- `npx nervegraph query --changed --json` — changed files, their dependents and the tests to run',
    '- `npx nervegraph scan --quiet` — re-scan after adding or moving files',
    '',
    `Entrypoints: ${o.entrypoints.slice(0, 5).map(code).join(', ') || '—'}`,
    `Hubs (most depended on — edit with care): ${o.hubs.map(([f, n]) => `${code(f)} (${n})`).join(', ') || '—'}`,
    '',
  ].join('\n');
}

export async function runAgentsMd(args: { graph?: string }): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');
  process.stdout.write(agentsMd(await readGraph(graphPath)));
  return 0;
}
