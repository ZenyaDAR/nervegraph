import { writeFile, rename, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Graph } from './types.ts';

/**
 * Returns the byte length written, so callers don't re-serialize to measure it.
 *
 * Compact by default: the indentation of a 10k-file graph is megabytes the
 * viewer has to download and parse for nothing. `--pretty` brings it back for
 * anyone diffing a committed graph.json by hand.
 */
export async function writeGraphAtomic(outDir: string, graph: Graph, pretty = false): Promise<number> {
  await mkdir(outDir, { recursive: true });
  const finalPath = path.join(outDir, 'graph.json');
  const tmpPath = finalPath + '.tmp';
  const content = pretty ? JSON.stringify(graph, null, 2) : JSON.stringify(graph);
  await writeFile(tmpPath, content);
  await rename(tmpPath, finalPath);
  return Buffer.byteLength(content);
}

export async function readGraph(graphPath: string): Promise<Graph> {
  const content = await readFile(graphPath, 'utf8');
  return JSON.parse(content);
}
