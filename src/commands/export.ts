import path from 'node:path';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { readGraph } from '../graph/io.ts';
import type { Graph } from '../graph/types.ts';

// A screenshot answers "what does it look like"; a text export answers "what
// did this look like at commit X" — it lives in the README, the ADR or the PR
// and diffs like code. Both formats are plain text on purpose.

export interface ExportArgs {
  format?: string;
  graph?: string;
  focus?: string;
  depth?: number;
  out?: string;
}

const LARGE = 300;

export async function runExport(args: ExportArgs): Promise<number> {
  const format = args.format ?? 'mermaid';
  if (format !== 'mermaid' && format !== 'dot') {
    console.error(`error: unknown format "${format}" (mermaid | dot)`);
    return 2;
  }
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');
  if (!existsSync(graphPath)) {
    console.error(`error: graph not found at ${graphPath}`);
    console.error('run: nerve scan');
    return 5;
  }
  const graph = await readGraph(graphPath);

  let ids: Set<string>;
  if (args.focus) {
    if (!graph.nodes.some(n => n.id === args.focus)) {
      console.error(`error: ${args.focus} is not in the graph`);
      return 5;
    }
    ids = subgraph(graph, args.focus, args.depth ?? 1);
  } else {
    ids = new Set(graph.nodes.map(n => n.id));
  }

  if (ids.size > LARGE) {
    console.error(`warning: ${ids.size} nodes — most renderers choke past ~${LARGE}. Narrow it with --focus <file> --depth <n>.`);
  }

  const text = format === 'dot' ? toDot(graph, ids) : toMermaid(graph, ids);
  if (args.out) {
    await writeFile(path.resolve(args.out), text);
    console.error(`written ${args.out} (${ids.size} nodes)`);
  } else {
    console.log(text);
  }
  return 0;
}

/** Everything within `depth` hops of `id`, in either direction. */
export function subgraph(graph: Graph, id: string, depth: number): Set<string> {
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const e of graph.edges) {
      if (frontier.includes(e.from) && !seen.has(e.to)) { seen.add(e.to); next.push(e.to); }
      if (frontier.includes(e.to) && !seen.has(e.from)) { seen.add(e.from); next.push(e.from); }
    }
    frontier = next;
    if (!next.length) break;
  }
  return seen;
}

export function toMermaid(graph: Graph, ids: Set<string>): string {
  const alias = new Map<string, string>();
  let i = 0;
  const lines = ['graph LR'];
  for (const n of graph.nodes) {
    if (!ids.has(n.id)) continue;
    const key = `n${i++}`;
    alias.set(n.id, key);
    lines.push(`  ${key}["${n.id.replace(/"/g, "'")}"]`);
  }
  for (const e of graph.edges) {
    const from = alias.get(e.from), to = alias.get(e.to);
    if (from && to) lines.push(`  ${from} -->|${e.rel}| ${to}`);
  }
  return lines.join('\n') + '\n';
}

export function toDot(graph: Graph, ids: Set<string>): string {
  const quote = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
  const lines = ['digraph nervegraph {', '  rankdir=LR;', '  node [shape=box, fontname="monospace"];'];
  for (const n of graph.nodes) {
    if (!ids.has(n.id)) continue;
    const attrs = [`label=${quote(n.id)}`];
    if (n.entrypoint) attrs.push('penwidth=2');
    if (n.missing) attrs.push('style=dashed');
    lines.push(`  ${quote(n.id)} [${attrs.join(', ')}];`);
  }
  for (const e of graph.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    lines.push(`  ${quote(e.from)} -> ${quote(e.to)} [label=${quote(e.rel)}];`);
  }
  lines.push('}');
  return lines.join('\n') + '\n';
}
