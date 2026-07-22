import { writeFile, rename, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Graph } from './types.ts';

/** Returns the byte length written, so callers don't re-serialize to measure it. */
export async function writeGraphAtomic(outDir: string, graph: Graph): Promise<number> {
  await mkdir(outDir, { recursive: true });
  const finalPath = path.join(outDir, 'graph.json');
  const tmpPath = finalPath + '.tmp';
  const content = JSON.stringify(graph, null, 2);
  await writeFile(tmpPath, content);
  await rename(tmpPath, finalPath);
  return Buffer.byteLength(content);
}

export async function readGraph(graphPath: string): Promise<Graph> {
  const content = await readFile(graphPath, 'utf8');
  return JSON.parse(content);
}
