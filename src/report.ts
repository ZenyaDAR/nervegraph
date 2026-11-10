import type { Graph } from './graph/types.ts';
import { fileKind, isExternal } from './graph/analysis.ts';
import { VERSION } from './version.ts';

export function printScanReport(graph: Graph, outPath: string, sizeBytes: number, quiet: boolean): void {
  if (quiet) return;
  const lines: string[] = [];
  lines.push(`nervegraph ${VERSION} · profile: ${graph.profile}`);
  lines.push('');
  lines.push(`  scanning  ${graph.root}`);
  lines.push(`  ✓ ${graph.stats.files} files`);
  lines.push(`  ✓ ${graph.stats.edges} edges`);
  // External references (packages, builtins, URLs) are expected; only the rest
  // are references the scan genuinely could not follow.
  const external = graph.unresolved.filter(isExternal).length;
  const unresolved = graph.unresolved.length - external;
  if (unresolved > 0) lines.push(`  ⚠ ${unresolved} unresolved references`);
  if (external > 0) lines.push(`  · ${external} external references (packages, builtins, URLs)`);
  const orphans = graph.nodes.filter(n => n.orphan);
  if (orphans.length) {
    const code = orphans.filter(n => fileKind(n.id) === 'code').length;
    lines.push(code
      ? `  ⚠ ${code} unreferenced code files (+${orphans.length - code} tests, docs, config, …)`
      : `  · ${orphans.length} unreferenced files, none of them code (tests, docs, config, …)`);
  }

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
  lines.push('  next  nerve overview  ·  nerve view');
  console.log(lines.join('\n'));
}
