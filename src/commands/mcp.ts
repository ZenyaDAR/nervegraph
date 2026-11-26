import { createInterface } from 'node:readline';
import { resolveGraphPath } from '../graph/io.ts';
import type { Graph } from '../graph/types.ts';
import { VERSION } from '../version.ts';
import {
  DEFAULT_LIMIT, LIST_KINDS, fileCard, listResult, loadFreshGraph, lookupFailureMessage, lookupNode, projectRoot, symbolReport,
  type Direction, type ListKind,
} from './query.ts';
import { changedReport, gitChangedFiles } from './changed.ts';
import { overview } from './overview.ts';

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

// Every tool only reads the project. readOnlyHint lets a client run the calls
// in parallel; the graph cache an autoscan rewrites is the tool's own file.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Few tools with crisp, non-overlapping descriptions: a model picks the right
// one from the description alone. Each description leads with the question it
// answers and says what a grep loop would cost instead — measured on a theme,
// agents with these tools connected still never called them when the text only
// listed fields.
export const TOOLS = [
  {
    name: 'nervegraph_query',
    title: 'What a change to this file affects',
    description: 'What breaks if I change, move or delete this file? One call instead of a chain of greps: every file that uses it ' +
      '(usedBy, with line numbers and imported names), what it uses, every indirect dependent through any chain of imports, ' +
      'renders, includes, theme blocks or custom elements (indirectDependents, grouped by type such as section, template_json, ' +
      'javascript), counts by type (affectedByType), the test files that reach it (tests) and its risk. ' +
      'A file name or path is enough; a wrong one returns the closest matches.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Path relative to the project root, an absolute path, or just the file name' },
        depth: { type: 'integer', minimum: 1, description: 'Also list files within this many hops' },
        direction: { type: 'string', enum: DIRECTIONS, description: 'For depth: in = dependents, out = dependencies (default both)' },
        transitive: { type: 'boolean', description: 'Also list every dependent as one flat list' },
        raw: { type: 'boolean', description: 'Include the source text of each reference' },
        limit: LIMIT,
      },
      required: ['file'],
      additionalProperties: false,
    },
    annotations: { title: 'What a change to this file affects', ...READ_ONLY },
    // Loaded with the session instead of behind a tool search: this is the
    // call that replaces the grep an agent reaches for by default.
    _meta: { 'anthropic/alwaysLoad': true },
  },
  {
    name: 'nervegraph_overview',
    title: 'Project map',
    description: 'Start here in an unfamiliar repo: languages, top folders, entrypoints, hub files (most depended on — edit with care), ' +
      'cycle/missing/orphan/unresolved counts and the calls to make next. About 1 KB.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Project map', ...READ_ONLY },
  },
  {
    name: 'nervegraph_symbol',
    title: 'Who imports this export',
    description: 'Before renaming or changing the signature of an exported function, class, const or type: the file that exports it ' +
      'and every file:line that imports it by name, plus namespace imports that may use it. Module exports only — a local ' +
      'function or a method is not tracked (the answer says so).',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Exact export name, e.g. readGraph' }, limit: LIMIT },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: { title: 'Who imports this export', ...READ_ONLY },
  },
  {
    name: 'nervegraph_changed',
    title: 'Impact of the current changes',
    description: 'After editing: the files changed in git (working tree, plus vs `base` when given), every file that depends on them ' +
      'directly or indirectly, and the test files to run.',
    inputSchema: {
      type: 'object',
      properties: { base: { type: 'string', description: 'Also include changes since this ref, e.g. main or HEAD~1' }, limit: LIMIT },
      additionalProperties: false,
    },
    annotations: { title: 'Impact of the current changes', ...READ_ONLY },
  },
  {
    name: 'nervegraph_list',
    title: 'Project-wide lists',
    description: 'Project-wide lists: orphans (code nothing references — deletion candidates), missing files, ' +
      'unresolved references, files at a risk level, unused exports, duplicate files, dependency cycles, packages (monorepo map).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...LIST_KINDS] },
        risk: { type: 'string', enum: RISKS, description: 'Only with kind=risk; default high' },
        all: { type: 'boolean', description: 'kind=orphans: also tests, fixtures, docs, config, assets; kind=unresolved: also external packages and URLs' },
        fields: { type: 'array', items: { type: 'string' }, description: 'Keep only these row fields, e.g. ["file","risk"]' },
        limit: LIMIT,
      },
      required: ['kind'],
      additionalProperties: false,
    },
    annotations: { title: 'Project-wide lists', ...READ_ONLY },
  },
];

// Claude Code uses these to decide when to search for the tools at all; it
// keeps the first 4096 characters.
export const INSTRUCTIONS = [
  'nervegraph answers "what uses this file, and what does changing it break" from a dependency graph of the whole project:',
  'imports and re-exports, import maps and path aliases, Liquid render/include/section/theme blocks/schema blocks, custom elements, CSS @import/url(), HTML src/href, and more.',
  'Prefer it over grep when the question is about relationships between files:',
  '- before editing, moving or deleting a file: nervegraph_query (direct and indirect dependents grouped by type, tests to run);',
  '- before renaming an export: nervegraph_symbol;',
  '- after edits: nervegraph_changed;',
  '- in an unfamiliar repo: nervegraph_overview; deletion candidates, cycles, missing files: nervegraph_list.',
  'It is static: string-built paths, events, globals and runtime lookups are invisible — use grep for those, and for text inside files.',
].join('\n');

/** The instructions, saying whether the graph keeps itself fresh — it does not under --no-autoscan. */
export function instructionsFor(autoscan: boolean): string {
  return INSTRUCTIONS + '\n' + (autoscan
    ? 'The graph is re-scanned automatically before a call when files changed.'
    : 'This server never re-scans: after adding or moving files, run `nerve scan`.');
}

// Revisions whose methods this server's handful (initialize, ping, tools/*) means the same thing in.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** A tool that ran but could not answer: reported in-band, with `isError`. */
export class ToolError extends Error {}

export interface McpOptions {
  /** Re-scan before a tool call when graph.json is missing or older than a file it covers. */
  autoscan?: boolean;
}

export async function runMcp(args: { graph?: string; noAutoscan?: boolean }): Promise<number> {
  // A stdio server's working directory is the client's choice; Claude Code
  // names the project it serves in CLAUDE_PROJECT_DIR.
  const graphPath = resolveGraphPath(args.graph, process.env.CLAUDE_PROJECT_DIR || process.cwd());
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
    case 'initialize': {
      // Echo the client's revision when we speak it, else offer our newest.
      const asked = msg.params?.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'nervegraph', title: 'nervegraph', version: VERSION },
        instructions: instructionsFor(!!opts.autoscan),
      });
    }
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
        const { graph, checked } = await loadFreshGraph(graphPath, !!opts.autoscan, { scanOutsideRepo: true });
        const text = await callTool(graph, name, msg.params?.arguments ?? {}, { graphPath, fresh: checked });
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

const json = (value: unknown) => JSON.stringify(value);

function limitOf(input: any): number | undefined {
  const v = input?.limit;
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || v < 0) throw new ToolError('"limit" must be a whole number ≥ 0');
  return v;
}

export async function callTool(graph: Graph, name: string, input: any, ctx: { graphPath?: string; fresh?: boolean } = {}): Promise<string> {
  const limit = limitOf(input);

  if (name === 'nervegraph_overview') return json(overview(graph, ctx.graphPath, ctx.fresh));

  if (name === 'nervegraph_query') {
    const file = input?.file;
    if (typeof file !== 'string' || !file.trim()) throw new ToolError('"file" is required: a path or a file name');
    const depth = input?.depth;
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 1)) throw new ToolError('"depth" must be a whole number ≥ 1');
    const direction = input?.direction;
    if (direction !== undefined && !DIRECTIONS.includes(direction)) throw new ToolError(`unknown direction: ${direction} (${DIRECTIONS.join(' | ')})`);
    const found = lookupNode(graph, file, ctx.graphPath);
    if (!found.node) throw new ToolError(lookupFailureMessage(found));
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
