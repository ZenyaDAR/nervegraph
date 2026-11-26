import path from 'node:path';
import { resolveGraphPath } from '../graph/io.ts';
import type { Graph, GraphNode } from '../graph/types.ts';
import { fileKind, isExternal } from '../graph/analysis.ts';
import { loadFreshGraph, sortKinds, staleFiles, toJson } from './query.ts';

// One call that answers "how is this project laid out" — the question an agent
// landing in an unfamiliar repo asks first, and the one no single query could
// answer. Kept to about a kilobyte: counts and a few names, never full lists.

const TOP = 5;

/** `fresh`: the graph was just checked (autoscan), so stat-ing every file again to count stale ones is wasted. */
export function overview(graph: Graph, graphPath?: string, fresh = false) {
  const files = graph.nodes.filter(n => !n.missing);
  const top = (pick: (n: GraphNode) => number) => [...files]
    .filter(n => pick(n) > 0)
    .sort((a, b) => pick(b) - pick(a) || a.id.localeCompare(b.id))
    .slice(0, TOP)
    .map(n => [n.id, pick(n)] as [string, number]);

  const orphanKinds: Record<string, number> = {};
  for (const n of files) if (n.orphan) { const k = fileKind(n.id); orphanKinds[k] = (orphanKinds[k] ?? 0) + 1; }

  const external = graph.unresolved.filter(isExternal).length;
  // A README, a test fixture or a config/locale file the scanner treats as an
  // entry is not where the project starts: on a Shopify theme the 80 locale
  // files pushed every layout and template out of the list.
  // A theme's layouts and templates before the sections and blocks a merchant
  // may place; within each, the ones that pull in the most first.
  const placeable = (n: GraphNode) => graph.profile === 'shopify' && /^(sections|blocks)\//.test(n.id) ? 1 : 0;
  // A JSON template is a page, not config.
  const entrypoints = files.filter(n => n.entrypoint && (n.type === 'template_json' || !['doc', 'asset', 'fixture', 'test', 'config'].includes(fileKind(n.id))))
    .sort((a, b) => placeable(a) - placeable(b) || b.out - a.out || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map(n => n.id);
  // Unreferenced files that look like something run directly (bin/, scripts/, cli.*).
  const likelyEntries = files.filter(n => n.orphan && fileKind(n.id) === 'entry').map(n => n.id);
  // Hubs are what an edit breaks; a translation file every template reads is data, not code to edit with care.
  const hubs = top(n => (fileKind(n.id) === 'config' ? 0 : n.in));

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
    stale: graphPath && !fresh ? staleFiles(graph, graphPath).length : 0,
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

export async function runOverview(args: { graph?: string; json?: boolean; pretty?: boolean; noAutoscan?: boolean }): Promise<number> {
  const graphPath = resolveGraphPath(args.graph);
  const { graph, checked } = await loadFreshGraph(graphPath, !args.noAutoscan);
  const o = overview(graph, graphPath, checked);
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
    'Before you grep for what uses a file, and before you edit, move, delete or rename one, ask the dependency graph.',
    'One call returns every direct and indirect dependent (through imports, renders, sections, blocks, custom elements), grouped by type, and the tests to run:',
    '',
    '- `npx nervegraph@latest query <file> --json` — `usedBy` with lines, `indirectDependents` by type, `affectedByType`, `tests`, `risk`',
    '- `npx nervegraph@latest query --symbol <name> --json` — before renaming an export: every import site',
    '- `npx nervegraph@latest query --changed --json` — after edits: what the changes reach and the tests to run',
    '- `npx nervegraph@latest overview` — layout, entrypoints, hubs, issue counts',
    '',
    '`query` and `overview` re-scan the graph themselves when files changed. Do not `cat` `.nervegraph/graph.json` — it is large. Grep is still the tool for text inside files and for string-built paths, events and globals the graph cannot see.',
    '',
    `Entrypoints: ${o.entrypoints.slice(0, 5).map(code).join(', ') || '—'}`,
    `Hubs (most depended on — edit with care): ${o.hubs.map(([f, n]) => `${code(f)} (${n})`).join(', ') || '—'}`,
    '',
  ].join('\n');
}

export async function runAgentsMd(args: { graph?: string; noAutoscan?: boolean }): Promise<number> {
  const graphPath = resolveGraphPath(args.graph);
  process.stdout.write(agentsMd((await loadFreshGraph(graphPath, !args.noAutoscan)).graph));
  return 0;
}
