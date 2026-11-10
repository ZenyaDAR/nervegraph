import { writeFile, rename, mkdir, readFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import type { Graph } from './types.ts';
import { SCHEMA_VERSION } from './types.ts';

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
  // The previous scan survives as graph.prev.json, so `nerve diff` with no
  // arguments can say what the last re-scan changed. Copied, not renamed:
  // graph.json must never be briefly absent for a viewer or agent reading it.
  try { await copyFile(finalPath, prevGraphPath(finalPath)); } catch { /* first scan */ }
  await rename(tmpPath, finalPath);
  return Buffer.byteLength(content);
}

/** Where the scan before the current one is kept, next to graph.json. */
export function prevGraphPath(graphPath: string): string {
  return path.join(path.dirname(graphPath), 'graph.prev.json');
}

/** A graph.json that cannot be used; `exitCode` is what the CLI exits with. */
export class GraphLoadError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'GraphLoadError';
    this.exitCode = exitCode;
  }
}

/**
 * Read and validate graph.json. Every command goes through here, so a
 * truncated, hand-edited or too-new file fails with one clear message instead
 * of `Cannot read properties of undefined` somewhere downstream.
 */
export async function readGraph(graphPath: string): Promise<Graph> {
  let content: string;
  try {
    content = await readFile(graphPath, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') throw new GraphLoadError(`graph not found at ${graphPath}\nrun: nerve scan`, 5);
    throw new GraphLoadError(`could not read ${graphPath}: ${e?.message ?? e}`, 1);
  }
  let data: any;
  try {
    data = JSON.parse(content);
  } catch (e: any) {
    throw new GraphLoadError(`${graphPath} is not valid JSON (${e?.message ?? e})\nrun: nerve scan`, 6);
  }
  return validateGraph(data, graphPath);
}

export function validateGraph(data: any, source = 'graph.json'): Graph {
  const bad = (why: string) => new GraphLoadError(`${source} is not a nervegraph graph: ${why}\nrun: nerve scan`, 6);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw bad('expected a JSON object');
  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) throw bad('missing schemaVersion');
  if (data.schemaVersion > SCHEMA_VERSION) {
    throw new GraphLoadError(
      `${source} has schemaVersion ${data.schemaVersion}, newer than this tool understands (${SCHEMA_VERSION})\nupdate nervegraph and try again`, 6);
  }
  if (typeof data.root !== 'string') throw bad('missing root');
  if (!Array.isArray(data.nodes) || !data.nodes.every((n: any) => n && typeof n.id === 'string')) {
    throw bad('nodes must be an array of { id }');
  }
  if (!Array.isArray(data.edges) || !data.edges.every((e: any) => e && typeof e.from === 'string' && typeof e.to === 'string')) {
    throw bad('edges must be an array of { from, to }');
  }
  // Optional in older schema versions; default them so callers need no guards.
  for (const key of ['unresolved', 'warnings', 'cycles', 'duplicates']) {
    if (data[key] === undefined) data[key] = [];
    else if (!Array.isArray(data[key])) throw bad(`${key} must be an array`);
  }
  if (!data.stats || typeof data.stats !== 'object') {
    data.stats = {
      files: data.nodes.length, edges: data.edges.length, unresolved: data.unresolved.length,
      orphans: data.nodes.filter((n: any) => n.orphan).length, byType: {},
    };
  }
  return data as Graph;
}

/**
 * The project a graph file belongs to: the directory holding `.nervegraph/`
 * when the graph lives there, otherwise the working directory. Used when the
 * absolute `graph.root` recorded at scan time does not exist here (the graph
 * was scanned on another machine or checkout).
 */
export function projectDirOf(graphPath: string): string {
  const dir = path.dirname(path.resolve(graphPath));
  return path.basename(dir) === '.nervegraph' ? path.dirname(dir) : process.cwd();
}
