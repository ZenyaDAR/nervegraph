import type { Graph } from './graph/types.ts';
import { VERSION } from './version.ts';

export function printScanReport(graph: Graph, outPath: string, sizeBytes: number, quiet: boolean): void {
  if (quiet) return;
  const lines: string[] = [];
  lines.push(`nervegraph ${VERSION} · profile: ${graph.profile}`);
  lines.push('');
  lines.push(`  scanning  ${graph.root}`);
  lines.push(`  ✓ ${graph.stats.files} files`);
  lines.push(`  ✓ ${graph.stats.edges} edges`);
  if (graph.stats.unresolved > 0) lines.push(`  ⚠ ${graph.stats.unresolved} unresolved references`);
  if (graph.stats.orphans > 0) lines.push(`  ⚠ ${graph.stats.orphans} orphan files`);

  if (graph.nodes.length >= 20) {
    const top = [...graph.nodes].sort((a, b) => b.in - a.in).slice(0, 3).filter(n => n.in > 0);
    if (top.length) {
      lines.push('');
      lines.push('  hot files');
      for (const n of top) lines.push(`    ${n.id.padEnd(30)} ← ${n.in}`);
    }
  }

  lines.push('');
  lines.push(`  written  ${outPath}  (${(sizeBytes / 1024).toFixed(0)} KB, ${graph.durationMs} ms)`);
  lines.push('');
  lines.push('  next  nerve view');
  console.log(lines.join('\n'));
}
