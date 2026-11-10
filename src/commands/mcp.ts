import path from 'node:path';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { projectDirOf, readGraph, writeGraphAtomic } from '../graph/io.ts';
import type { Graph } from '../graph/types.ts';
import { VERSION } from '../version.ts';
import {
  DEFAULT_LIMIT, LIST_KINDS, fileCard, listResult, lookupNode, projectRoot, staleFiles, symbolReport,
  type Direction, type ListKind,
} from './query.ts';
import { changedReport, gitChangedFiles } from './changed.ts';
import { overview } from './overview.ts';
import { buildGraph } from '../graph/build.ts';

// An MCP front door for the same facts `nerve query --json` prints. The
// roadmap rejected this on the grounds that query already covers the
// scenarios — true, but only for an agent that has been told the binary
// exists. MCP is how an agent finds out on its own.
//
// ponytail: hand-rolled JSON-RPC over stdio, no SDK. The protocol surface used
// here is a handful of methods; a dependency would be larger than the file.
//
// stdout is the protocol channel: nothing but JSON-RPC messages may go there.

type RpcId = number | string | null;
interface RpcResponse { jsonrpc: '2.0'; id: RpcId; result?: unknown; error?: { code: number; message: string } }

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const RISKS = ['low', 'medium', 'high'];
const DIRECTIONS = ['in', 'out', 'both'];
const LIMIT = { type: 'integer', minimum: 0, description: `Max entries per list (default ${DEFAULT_LIMIT}, 0 = all); dropped counts are reported under "truncated"` };

// Few tools with crisp, non-overlapping descriptions: a model picks the right
// one from the description alone.
export const TOOLS = [
  {
    name: 'nervegraph_overview',
    description: 'Start here in an unfamiliar repo. One small summary: languages, top folders, entrypoints, ' +
      'hub files (most depended on), cycle/missing/orphan/unresolved counts, and suggested next calls.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'nervegraph_query',
    description: 'Before editing, moving or deleting ONE file: which files use it (usedBy, with lines and imported names), ' +
      'what it uses, its risk, blast radius (transitiveDependents) and the test files that reach it (tests). ' +
      '`stale: true` means the file changed since the scan.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path relative to the project root, an absolute path, or just the file name' },
        depth: { type: 'integer', minimum: 1, description: 'Also list files within this many hops' },
        direction: { type: 'string', enum: DIRECTIONS, description: 'For depth: in = dependents, out = dependencies (default both)' },
        transitive: { type: 'boolean', description: 'List every transitive dependent, not just the count' },
        raw: { type: 'boolean', description: 'Include the source text of each reference' },
        limit: LIMIT,
      },
      required: ['file'],
    },
  },
  {
    name: 'nervegraph_symbol',
    description: 'Where a named export (function, class, const, type) is defined and every file:line that imports it by name. ' +
      'Use before renaming or changing the signature of a symbol.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact export name, e.g. readGraph' }, limit: LIMIT },
      required: ['name'],
    },
  },
  {
    name: 'nervegraph_changed',
    description: 'After editing: files changed in git (working tree, plus vs `base` when given), every file that depends on them, ' +
      'and the test files to run.',
    inputSchema: {
      type: 'object',
      properties: { base: { type: 'string', description: 'Also include changes since this ref, e.g. main or HEAD~1' }, limit: LIMIT },
    },
  },
  {
    name: 'nervegraph_list',
    description: 'Project-wide lists: orphans (unreferenced code; all=true adds tests/docs/config), missing files, ' +
      'unresolved references, files at a risk level, unused exports, duplicate files, dependency cycles, packages (monorepo map).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...LIST_KINDS] },
        risk: { type: 'string', enum: RISKS, description: 'Only with kind=risk; default high' },
        all: { type: 'boolean', description: 'Only with kind=orphans: include tests, fixtures, docs, config, assets' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Keep only these row fields, e.g. ["file","risk"]' },
        limit: LIMIT,
      },
      required: ['kind'],
    },
  },
];

/** A tool that ran but could not answer: reported in-band, with `isError`. */
export class ToolError extends Error {}

export interface McpOptions {
  /** Re-scan before a tool call when graph.json is missing or older than a file it covers. */
  autoscan?: boolean;
}

export async function runMcp(args: { graph?: string; noAutoscan?: boolean }): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');
  const opts: McpOptions = { autoscan: !args.noAutoscan };

  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');

  // Lines are handled one at a time, in order: a reply never overtakes the
  // reply to an earlier request, and the loop only ends after the last one is
  // written, so nothing in flight is lost when stdin closes.
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const reply = await handleLine(line, graphPath, opts);
    if (reply !== undefined) send(reply);
  }
  // Pipes may be asynchronous; wait until everything written is flushed.
  await new Promise<void>(resolve => process.stdout.write('', () => resolve()));
  return 0;
}

/** One line of input in, the response to write (if any) out. */
export async function handleLine(line: string, graphPath: string, opts: McpOptions = {}): Promise<RpcResponse | RpcResponse[] | undefined> {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return rpcError(null, PARSE_ERROR, 'Parse error');
  }
  if (Array.isArray(msg)) {
    if (!msg.length) return rpcError(null, INVALID_REQUEST, 'Invalid Request: empty batch');
    const replies: RpcResponse[] = [];
    for (const m of msg) {
      const r = await handleMessage(m, graphPath, opts);
      if (r) replies.push(r);
    }
    return replies.length ? replies : undefined;
  }
  return handleMessage(msg, graphPath, opts);
}

function rpcError(id: RpcId, code: number, message: string): RpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function isValidId(id: unknown): id is RpcId {
  return id === null || typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
}

async function handleMessage(msg: any, graphPath: string, opts: McpOptions): Promise<RpcResponse | undefined> {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' ||
      typeof msg.method !== 'string' || (msg.id !== undefined && !isValidId(msg.id))) {
    return rpcError(isValidId(msg?.id) ? msg.id : null, INVALID_REQUEST, 'Invalid Request');
  }
  // A notification (no id) gets no answer, whatever its method.
  if (msg.id === undefined) return undefined;
  const id: RpcId = msg.id;
  const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });

  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'nervegraph', version: VERSION },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!TOOLS.some(t => t.name === name)) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      try {
        // Re-read per call: `nerve scan --watch` may have rewritten it since,
        // and an agent acting on a stale graph is the failure this tool exists
        // to prevent.
        const graph = await loadGraph(graphPath, opts);
        const text = await callTool(graph, name, msg.params?.arguments ?? {}, { graphPath });
        return ok({ content: [{ type: 'text', text }] });
      } catch (e: any) {
        // A failed tool call is a result the agent should read, not a protocol fault.
        return ok({ content: [{ type: 'text', text: e?.message ?? String(e) }], isError: true });
      }
    }
    default:
      return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
  }
}

/**
 * Read the graph, re-scanning first when autoscan is on and the graph is
 * missing or a file it covers changed since. Only a graph at `<dir>/graph.json`
 * is rewritten — that is the only name a scan writes.
 */
async function loadGraph(graphPath: string, opts: McpOptions): Promise<Graph> {
  if (!opts.autoscan || path.basename(graphPath) !== 'graph.json') return readGraph(graphPath);
  let graph: Graph | undefined;
  if (existsSync(graphPath)) {
    graph = await readGraph(graphPath);
    const stale = staleFiles(graph, graphPath).length;
    if (!stale) return graph;
    console.error(`nervegraph: ${stale} files changed since the scan, re-scanning`);
  } else {
    console.error(`nervegraph: no graph at ${graphPath}, scanning`);
  }
  const root = graph ? projectRoot(graph, graphPath) : projectDirOf(graphPath);
  const fresh = await buildGraph({ root, profile: graph?.profile });
  await writeGraphAtomic(path.dirname(graphPath), fresh);
  return fresh;
}

const json = (value: unknown) => JSON.stringify(value);

function limitOf(input: any): number | undefined {
  const v = input?.limit;
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 0) throw new ToolError('"limit" must be a whole number ≥ 0');
  return v;
}

export async function callTool(graph: Graph, name: string, input: any, ctx: { graphPath?: string } = {}): Promise<string> {
  const limit = limitOf(input);

  if (name === 'nervegraph_overview') return json(overview(graph, ctx.graphPath));

  if (name === 'nervegraph_query') {
    const file = input?.file;
    if (typeof file !== 'string' || !file.trim()) throw new ToolError('"file" is required: a path or a file name');
    const depth = input?.depth;
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) throw new ToolError('"depth" must be a whole number ≥ 1');
    const direction = input?.direction;
    if (direction !== undefined && !DIRECTIONS.includes(direction)) throw new ToolError(`unknown direction: ${direction} (${DIRECTIONS.join(' | ')})`);
    const found = lookupNode(graph, file, ctx.graphPath);
    if (!found.node) {
      if (!found.candidates.length) throw new ToolError(`${found.query} is not in the graph`);
      const list = found.candidates.slice(0, 20).map(n => `  ${n.id}`).join('\n');
      const more = found.candidates.length > 20 ? `\n  … ${found.candidates.length - 20} more` : '';
      throw new ToolError(`${found.query} matches ${found.candidates.length} files; pass one of these paths:\n${list}${more}`);
    }
    return json(fileCard(graph, found.node, {
      graphPath: ctx.graphPath, depth, direction: direction as Direction | undefined,
      transitive: input?.transitive === true, raw: input?.raw === true, limit,
    }));
  }

  if (name === 'nervegraph_symbol') {
    const symbol = input?.name;
    if (typeof symbol !== 'string' || !symbol.trim()) throw new ToolError('"name" is required: an export name');
    return json(symbolReport(graph, symbol.trim(), limit));
  }

  if (name === 'nervegraph_changed') {
    const base = input?.base;
    if (base !== undefined && typeof base !== 'string') throw new ToolError('"base" must be a git ref');
    const root = ctx.graphPath ? projectRoot(graph, ctx.graphPath) : graph.root;
    try {
      return json(changedReport(graph, gitChangedFiles(root, base), { limit, base }));
    } catch (e: any) {
      throw new ToolError(e?.message ?? String(e));
    }
  }

  if (name === 'nervegraph_list') {
    const kind = String(input?.kind ?? '');
    if (!(LIST_KINDS as readonly string[]).includes(kind)) throw new ToolError(`unknown kind: ${kind} (${LIST_KINDS.join(' | ')})`);
    const risk = input?.risk ?? 'high';
    if (kind === 'risk' && !RISKS.includes(risk)) throw new ToolError(`unknown risk: ${risk} (${RISKS.join(' | ')})`);
    const fields = Array.isArray(input?.fields) ? input.fields.filter((f: unknown) => typeof f === 'string') : undefined;
    return json(listResult(graph, kind as ListKind, { risk, all: input?.all === true, limit, fields }));
  }

  throw new ToolError(`unknown tool: ${name}`);
}
