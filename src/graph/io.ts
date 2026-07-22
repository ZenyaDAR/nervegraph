import { writeFile, rename, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Graph } from './types.ts';

export async function writeGraphAtomic(outDir: string, graph: Graph): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const finalPath = path.join(outDir, 'graph.json');
  const tmpPath = finalPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(graph, null, 2));
  await rename(tmpPath, finalPath);

  const gitignorePath = path.join(outDir, '.gitignore');
  await writeFile(gitignorePath, 'meta.json\n').catch(() => {});
}

export async function writeMetaAtomic(outDir: string, meta: unknown): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const finalPath = path.join(outDir, 'meta.json');
  const tmpPath = finalPath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(meta, null, 2));
  await rename(tmpPath, finalPath);
}

export async function readGraph(graphPath: string): Promise<Graph> {
  const content = await readFile(graphPath, 'utf8');
  return JSON.parse(content);
}
