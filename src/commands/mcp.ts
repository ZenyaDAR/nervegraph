import path from 'node:path';
import { existsSync } from 'node:fs';
import { readGraph } from '../graph/io.ts';
import type { Graph } from '../graph/types.ts';
import { VERSION } from '../version.ts';

// An MCP front door for the same facts `nerve query --json` prints. The
// roadmap rejected this on the grounds that query already covers the
// scenarios — true, but only for an agent that has been told the binary
// exists. MCP is how an agent finds out on its own.
//
// ponytail: hand-rolled JSON-RPC over stdio, no SDK. The protocol surface used
// here is three methods; a dependency would be larger than the file.

interface Rpc { jsonrpc: '2.0'; id?: number | string | null; method?: string; params?: any }

const TOOLS = [
  {
    name: 'nervegraph_query',
    description: 'What uses this file and what it uses, with risk and blast radius. Call before editing or deleting a file.',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string', description: 'Path relative to the scanned root, or just the file name' } },
      required: ['file'],
    },
  },
  {
    name: 'nervegraph_list',
    description: 'List orphan files, missing files, high-risk files, unused exports, duplicates or cycles.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['orphans', 'missing', 'risk', 'dead-exports', 'duplicates', 'cycles'] },
        risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Only with kind=risk' },
      },
      required: ['kind'],
    },
  },
];

export async function runMcp(args: { graph?: string }): Promise<number> {
  const graphPath = path.resolve(args.graph ?? '.nervegraph/graph.json');

  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + '\n');
  const reply = (id: Rpc['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (id: Rpc['id'], message: string) => send({ jsonrpc: '2.0', id, error: { code: -32603, message } });

  // Re-read per call: `nerve scan --watch` may have rewritten it since, and an
  // agent acting on a stale graph is the failure this tool exists to prevent.
  const load = async (): Promise<Graph> => {
    if (!existsSync(graphPath)) throw new Error(`graph not found at ${graphPath} — run: nerve scan`);
    return readGraph(graphPath);
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Rpc;
      try { msg = JSON.parse(line); } catch { continue; }
      // A notification (no id) needs no answer.
      if (msg.id === undefined || msg.id === null) continue;

      try {
        if (msg.method === 'initialize') {
          reply(msg.id, {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'nervegraph', version: VERSION },
          });
        } else if (msg.method === 'tools/list') {
          reply(msg.id, { tools: TOOLS });
        } else if (msg.method === 'tools/call') {
          const text = await callTool(await load(), msg.params?.name, msg.params?.arguments ?? {});
          reply(msg.id, { content: [{ type: 'text', text }] });
        } else {
          fail(msg.id, `unknown method: ${msg.method}`);
        }
      } catch (e: any) {
        fail(msg.id, e?.message ?? String(e));
      }
    }
  });

  await new Promise<void>(resolve => process.stdin.on('end', resolve));
  return 0;
}

export async function callTool(graph: Graph, name: string, input: any): Promise<string> {
  if (name === 'nervegraph_query') {
    const want = String(input.file ?? '');
    const node = graph.nodes.find(n => n.id === want)
      ?? graph.nodes.find(n => n.id.endsWith('/' + want))
      ?? graph.nodes.find(n => n.id.split('/').pop() === want);
    if (!node) throw new Error(`${want} is not in the graph`);
    return JSON.stringify({
      file: node.id, type: node.type, lang: node.lang, loc: node.loc,
      risk: node.risk, orphan: node.orphan, entrypoint: node.entrypoint,
      missing: !!node.missing, churn: node.churn, deadExports: node.deadExports,
      counts: { in: node.in, out: node.out },
      usedBy: graph.edges.filter(e => e.to === node.id).map(e => ({ file: e.from, rel: e.rel, line: e.line, raw: e.raw })),
      uses: graph.edges.filter(e => e.from === node.id).map(e => ({ file: e.to, rel: e.rel, line: e.line, raw: e.raw })),
      graphScannedAt: graph.scannedAt,
    }, null, 2);
  }

  if (name === 'nervegraph_list') {
    const kind = String(input.kind ?? '');
    if (kind === 'cycles') return JSON.stringify({ cycles: graph.cycles ?? [] }, null, 2);
    if (kind === 'duplicates') return JSON.stringify({ duplicates: graph.duplicates ?? [] }, null, 2);
    if (kind === 'dead-exports') {
      return JSON.stringify({
        files: graph.nodes.filter(n => n.deadExports?.length).map(n => ({ file: n.id, deadExports: n.deadExports })),
      }, null, 2);
    }
    const match = (id: string) => graph.nodes.filter(n =>
      kind === 'orphans' ? n.orphan : kind === 'missing' ? !!n.missing : n.risk === (input.risk ?? 'high'));
    if (!['orphans', 'missing', 'risk'].includes(kind)) throw new Error(`unknown kind: ${kind}`);
    return JSON.stringify({ files: match(kind).map(n => ({ file: n.id, risk: n.risk, counts: { in: n.in, out: n.out } })) }, null, 2);
  }

  throw new Error(`unknown tool: ${name}`);
}
