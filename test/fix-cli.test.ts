import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createServer, isAllowedHost, listenOnFreePort, MAX_EVENT_CLIENTS } from '../src/server.ts';
import { normalizeId, lookupNode, fileCard } from '../src/commands/query.ts';
import { runExport, toDot, toMermaid } from '../src/commands/export.ts';
import { validateRules } from '../src/commands/check.ts';
import { isIgnoredWatchEvent, runScan } from '../src/commands/scan.ts';
import { readGraph, writeGraphAtomic, GraphLoadError } from '../src/graph/io.ts';
import { handleLine } from '../src/commands/mcp.ts';
import type { Graph } from '../src/graph/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.ts');

function cli(args: string[], input?: string) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], {
    input, encoding: 'utf8', timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'javascript', lang: 'javascript', size: 1, loc: 1, hash: 'h',
  in: 0, out: 0, risk: 'low', orphan: false, entrypoint: false, ...extra,
});

/** A project dir with `.nervegraph/graph.json` whose recorded root is elsewhere. */
function project(root?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'nervegraph-fix-cli-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  mkdirSync(path.join(dir, '.nervegraph'));
  writeFileSync(path.join(dir, 'src', 'a.js'), "import './util.js';\n");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(path.join(dir, 'src', 'a.js'), old, old);
  const graph = {
    schemaVersion: 4, tool: 'test', root: root ?? dir, profile: 'js',
    scannedAt: new Date().toISOString(), durationMs: 1,
    stats: { files: 4, edges: 2, unresolved: 0, orphans: 0, byType: {} },
    nodes: [node('src/a.js', { out: 1 }), node('src/util.js', { in: 2 }), node('lib/util.js'), node('src/b.js', { out: 1 })],
    edges: [
      { from: 'src/a.js', to: 'src/util.js', rel: 'import', line: 1, raw: "import './util.js'" },
      { from: 'src/b.js', to: 'src/util.js', rel: 'import', line: 1, raw: "import './util.js'" },
    ],
    unresolved: [], warnings: [], cycles: [], duplicates: [],
  };
  const graphPath = path.join(dir, '.nervegraph', 'graph.json');
  writeFileSync(graphPath, JSON.stringify(graph));
  return { dir, graphPath, graph: graph as unknown as Graph };
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const log = console.log, error = console.error;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
  try { return { value: await fn(), out: out.join('\n'), err: err.join('\n') }; }
  finally { console.log = log; console.error = error; }
}

// --- 1. viewer XSS ---------------------------------------------------------

test('viewer: node tooltips are DOM text, never an HTML string', () => {
  const app = readFileSync(path.join(HERE, '..', 'viewer', 'app.js'), 'utf8');
  assert.ok(!/\.nodeLabel\(\s*n\s*=>\s*n\.id\s*\)/.test(app), 'nodeLabel must not return the raw id string');
  assert.match(app, /\.nodeLabel\(nodeTooltip\)/);
  assert.match(app, /function nodeTooltip\(n\)\s*\{[^}]*textContent = n\.id/);
  // innerHTML may only ever be assigned a static literal.
  for (const m of app.matchAll(/innerHTML\s*=\s*([^;]+);/g)) {
    assert.match(m[1].trim(), /^'[^'$`]*'$/, `innerHTML assigned a non-literal: ${m[1]}`);
  }
});

// --- 2. server ---------------------------------------------------------------

test('server: only loopback Host headers on the bound port are served', async () => {
  const { graphPath } = project();
  const server = createServer(graphPath);
  const port = await listenOnFreePort(server, 0);
  assert.ok(port > 0, 'port 0 resolves to the port actually bound');
  const get = (host: string) => new Promise<number>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/graph.json', headers: { host } }, res => {
      res.resume(); resolve(res.statusCode!);
    }).on('error', reject);
  });
  try {
    assert.equal(await get(`localhost:${port}`), 200);
    assert.equal(await get(`127.0.0.1:${port}`), 200);
    assert.equal(await get(`[::1]:${port}`), 200);
    assert.equal(await get(`evil.example:${port}`), 403);
    assert.equal(await get('localhost'), 403, 'wrong (default) port');
    assert.equal(await get(`localhost.evil.example:${port}`), 403);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
  assert.equal(isAllowedHost(undefined, 80), false);
  assert.equal(isAllowedHost('LOCALHOST:80', 80), true);
});

test('server: /events connections are capped', async () => {
  const { graphPath } = project();
  const server = createServer(graphPath);
  const port = await listenOnFreePort(server, 0);
  const open: http.ClientRequest[] = [];
  const connect = () => new Promise<number>((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => resolve(res.statusCode!));
    req.on('error', reject);
    open.push(req);
  });
  try {
    for (let i = 0; i < MAX_EVENT_CLIENTS; i++) assert.equal(await connect(), 200);
    assert.equal(await connect(), 503);
  } finally {
    for (const r of open) r.destroy();
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('server: live reload survives the rename-based atomic write', async () => {
  const { graphPath, graph } = project();
  const server = createServer(graphPath);
  const port = await listenOnFreePort(server, 0);
  let req: http.ClientRequest | undefined;
  try {
    const events = (n: number) => new Promise<void>((resolve, reject) => {
      let seen = 0;
      req = http.get({ host: '127.0.0.1', port, path: '/events', agent: false }, res => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (chunk.includes('event: graph') && ++seen === n) resolve();
        });
        // Write twice: a watch on the file itself goes deaf after the first rename.
        setTimeout(() => void writeGraphAtomic(path.dirname(graphPath), graph), 100);
        setTimeout(() => void writeGraphAtomic(path.dirname(graphPath), graph), 800);
      });
      req.on('error', reject);
      setTimeout(() => reject(new Error(`saw ${seen} of ${n} reload events`)), 5000).unref();
    });
    await events(2);
  } finally {
    req?.destroy();
    await new Promise<void>(r => server.close(() => r()));
  }
});

test('server: a busy port moves on, and all-busy rejects instead of crashing', async () => {
  const blocker = net.createServer();
  await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r));
  const busy = (blocker.address() as AddressInfo).port;
  try {
    const s1 = http.createServer();
    await assert.rejects(() => listenOnFreePort(s1, busy, '127.0.0.1', 1), /no free port/);
    const s2 = http.createServer();
    const got = await listenOnFreePort(s2, busy, '127.0.0.1', 20);
    assert.notEqual(got, busy);
    await new Promise<void>(r => s2.close(() => r()));
  } finally {
    await new Promise<void>(r => blocker.close(() => r()));
  }
});

// --- 3. MCP -----------------------------------------------------------------

test('mcp: replies in flight when stdin ends are still written', () => {
  const { graphPath } = project();
  const input = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nervegraph_query', arguments: { file: 'src/a.js' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    '{not json',
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'nope' }),
  ].join('\n') + '\n';
  const r = cli(['mcp', '--graph', graphPath], input);
  assert.equal(r.code, 0, r.err);
  const replies = r.out.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(replies.map(m => m.id), [1, 2, null, 3], 'in order, one per request, none for the notification');
  assert.equal(JSON.parse(replies[0].result.content[0].text).file, 'src/a.js');
  assert.deepEqual(replies[1].result, {});
  assert.equal(replies[2].error.code, -32700);
  assert.equal(replies[3].error.code, -32601);
});

test('mcp: batches, invalid requests and tool failures', async () => {
  const { graphPath } = project();
  const call = async (msg: unknown) => handleLine(typeof msg === 'string' ? msg : JSON.stringify(msg), graphPath) as Promise<any>;
  const tool = (args: unknown) => call({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'nervegraph_query', arguments: args } });

  assert.equal((await call('[]')).error.code, -32600);
  const batch = await call([{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'ping' }, { id: 'b' }]);
  assert.deepEqual(batch.map((m: any) => m.id), ['a', 'b']);
  assert.equal(batch[1].error.code, -32600);

  const ambiguous = await tool({ file: 'util.js' });
  assert.equal(ambiguous.result.isError, true);
  assert.match(ambiguous.result.content[0].text, /src\/util\.js[\s\S]*lib\/util\.js|lib\/util\.js[\s\S]*src\/util\.js/);

  for (const bad of [{}, { file: '' }, { file: '   ' }, { file: 42 }]) {
    const r = await tool(bad);
    assert.equal(r.result.isError, true, JSON.stringify(bad));
  }
  assert.equal((await tool({ file: 'missing.js' })).result.isError, true);

  const unknownTool = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope' } });
  assert.equal(unknownTool.error.code, -32602);

  // Same lookup as the CLI: backslashes and absolute paths.
  const card = JSON.parse((await tool({ file: '.\\src\\a.js' })).result.content[0].text);
  assert.equal(card.file, 'src/a.js');
  assert.equal(typeof card.transitiveDependents, 'number', 'the blast radius the description promises');

  const noGraph = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nervegraph_list', arguments: { kind: 'orphans' } } }), path.join(tmpdir(), 'nope', 'graph.json')) as any;
  assert.equal(noGraph.result.isError, true);
});

// --- 4. node lookup --------------------------------------------------------------

test('lookup: backslashes, ./ prefixes and absolute paths', () => {
  const { dir, graph, graphPath } = project();
  assert.equal(normalizeId('.\\src\\a.js'), 'src/a.js');
  assert.equal(normalizeId('./src/a.js'), 'src/a.js');
  assert.equal(normalizeId(path.join(dir, 'src', 'a.js'), [dir]), 'src/a.js');
  if (process.platform === 'win32') {
    assert.equal(normalizeId(path.join(dir, 'src', 'a.js').toUpperCase(), [dir]), 'SRC/A.JS');
  }
  assert.equal(lookupNode(graph, path.join(dir, 'src', 'a.js'), graphPath).node?.id, 'src/a.js');
  assert.equal(lookupNode(graph, 'util', graphPath).candidates.length, 2);
});

test('lookup: export --focus takes short names and rejects ambiguous ones', async () => {
  const { graphPath } = project();
  const short = await quiet(() => runExport({ graph: graphPath, focus: 'a.js' }));
  assert.equal(short.value, 0);
  assert.match(short.out, /src\/a\.js/);
  assert.match(short.out, /src\/util\.js/);
  const ambiguous = await quiet(() => runExport({ graph: graphPath, focus: 'util.js' }));
  assert.equal(ambiguous.value, 2);
  assert.match(ambiguous.err, /matches 2 files/);
  assert.equal((await quiet(() => runExport({ graph: graphPath, focus: 'nope.js' }))).value, 5);
});

// --- 5. check ---------------------------------------------------------------

test('check: non-numeric budgets and malformed rules are usage errors', () => {
  const { graphPath, dir } = project();
  for (const flag of ['--max-cycles', '--max-unresolved', '--max-orphans']) {
    for (const v of ['abc', '-1', '1.5', '']) {
      const r = cli(['check', '--graph', graphPath, `${flag}=${v}`]);
      assert.equal(r.code, 2, `${flag}=${v}: ${r.err}`);
    }
  }
  assert.equal(cli(['check', '--graph', graphPath, '--max-cycles', '0']).code, 0);
  assert.equal(cli(['query', 'a.js', '--graph', graphPath, '--depth', 'x']).code, 2);
  assert.equal(cli(['view', '--graph', graphPath, '--port', '70000']).code, 2);

  assert.match(validateRules({}) ?? '', /array/);
  assert.match(validateRules([{ deny: 'x' }]) ?? '', /from/);
  assert.match(validateRules([{ from: 'a/**' }]) ?? '', /deny.*allow/);
  assert.match(validateRules([{ from: 'a/**', deny: 3 }]) ?? '', /deny/);
  assert.equal(validateRules([{ from: 'a/**', allow: 'b/**' }]), undefined);
  const rules = path.join(dir, 'rules.json');
  writeFileSync(rules, JSON.stringify({ from: 'a' }));
  const r = cli(['check', '--graph', graphPath, '--rules', rules]);
  assert.equal(r.code, 2);
  assert.match(r.err, /must be a JSON array/);
});

// --- 6. readGraph -------------------------------------------------------------

test('readGraph: a malformed or too-new graph fails with one clear error', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nervegraph-fix-io-'));
  const write = (name: string, body: string) => { const p = path.join(dir, name); writeFileSync(p, body); return p; };
  const cases: [string, RegExp][] = [
    [write('notjson.json', '{'), /not valid JSON/],
    [write('array.json', '[]'), /JSON object/],
    [write('noschema.json', '{"nodes":[],"edges":[],"root":"/"}'), /schemaVersion/],
    [write('future.json', '{"schemaVersion":999,"nodes":[],"edges":[],"root":"/"}'), /newer/],
    [write('nonodes.json', '{"schemaVersion":4,"edges":[],"root":"/"}'), /nodes/],
  ];
  for (const [p, re] of cases) {
    await assert.rejects(() => readGraph(p), (e: any) => e instanceof GraphLoadError && e.exitCode === 6 && re.test(e.message));
  }
  for (const cmd of [['query', 'x'], ['check'], ['export'], ['view', '--no-open']]) {
    const r = cli([...cmd, '--graph', cases[4][0]]);
    assert.equal(r.code, 6, `${cmd[0]}: ${r.err}`);
    assert.match(r.err, /not a nervegraph graph/);
    assert.ok(!/Cannot read properties/.test(r.err));
  }
  assert.equal(cli(['diff', cases[0][0], cases[4][0]]).code, 6);
  // Older schema versions without the newer optional arrays still load.
  const old = await readGraph(write('old.json', '{"schemaVersion":3,"nodes":[],"edges":[],"root":"/"}'));
  assert.deepEqual(old.cycles, []);
});

// --- 7. export --------------------------------------------------------------

test('export: dot and mermaid labels survive backslashes, quotes and newlines', () => {
  const evil = 'a\\"b\nc';
  const g = { nodes: [node(evil), node('x.js')], edges: [{ from: evil, to: 'x.js', rel: 'import', line: 1, raw: '' }] } as unknown as Graph;
  const ids = new Set([evil, 'x.js']);
  const dot = toDot(g, ids);
  assert.ok(dot.includes('"a\\\\\\"b\\nc"'), dot);
  assert.equal(dot.split('\n').filter(l => l.includes('label="a')).length, 1, 'the label stays on one line');
  const mermaid = toMermaid(g, ids);
  assert.ok(mermaid.includes(`["a\\'b c"]`), mermaid);
});

test('export/query: deep neighbourhoods on a large graph are fast', () => {
  const N = 20_000;
  const nodes = Array.from({ length: N }, (_, i) => node(`f${i}.js`));
  const edges = Array.from({ length: N - 1 }, (_, i) => ({ from: `f${i}.js`, to: `f${i + 1}.js`, rel: 'import', line: 1, raw: '' }));
  const graph = { root: '/', scannedAt: new Date().toISOString(), nodes, edges } as unknown as Graph;
  const start = Date.now();
  const card = fileCard(graph, nodes[N / 2] as any, { depth: 10 });
  assert.equal(card.neighbors!.length, 20);
  assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
});

// --- 8. scan --------------------------------------------------------------------

test('scan --watch ignores its own output dir, wherever it is', () => {
  const root = path.resolve(tmpdir(), 'proj');
  const out = path.join(root, '.nervegraph');
  assert.equal(isIgnoredWatchEvent(root, out, '.nervegraph'), true, 'bare dir name (Windows)');
  assert.equal(isIgnoredWatchEvent(root, out, path.join('.nervegraph', 'graph.json.tmp')), true);
  const custom = path.join(root, 'build', 'graph');
  assert.equal(isIgnoredWatchEvent(root, custom, path.join('build', 'graph', 'graph.json')), true);
  assert.equal(isIgnoredWatchEvent(root, custom, path.join('build', 'graphs.js')), false);
  assert.equal(isIgnoredWatchEvent(root, out, 'node_modules'), true);
  assert.equal(isIgnoredWatchEvent(root, out, path.join('src', 'a.js')), false);
  if (process.platform === 'win32') assert.equal(isIgnoredWatchEvent(root, out, '.NERVEGRAPH'), true);
});

test('scan --profile rejects unknown names', async () => {
  const r = await quiet(() => runScan({ path: '.', profile: 'bogus', quiet: true }));
  assert.equal(r.value, 2);
  assert.match(r.err, /shopify \| js \| poly \| auto/);
});

// --- 9. CLI help and exit codes ----------------------------------------------------

test('cli: help and version go to stdout with exit 0', () => {
  for (const args of [['--help'], ['-h'], ['help'], []]) {
    const r = cli(args);
    assert.equal(r.code, 0, args.join(' '));
    assert.match(r.out, /Usage:/);
  }
  const v = cli(['--version']);
  assert.equal(v.code, 0);
  assert.match(v.out.trim(), /^\d+\.\d+\.\d+/);
  for (const cmd of ['scan', 'view', 'query', 'check', 'diff', 'export', 'mcp']) {
    const r = cli([cmd, '--help']);
    assert.equal(r.code, 0, cmd);
    assert.match(r.out, new RegExp(`Usage: nerve ${cmd}`));
  }
  assert.match(cli(['mcp', '--help']).out, /--graph/);
});

test('cli: usage errors exit 2, and --json keeps stdout clean', () => {
  const { graphPath } = project();
  const unknownFlag = cli(['query', 'a.js', '--bogus']);
  assert.equal(unknownFlag.code, 2);
  assert.equal(unknownFlag.out, '');
  assert.equal(cli(['nope']).code, 2);
  const notFound = cli(['query', 'nope.js', '--json', '--graph', graphPath]);
  assert.equal(notFound.code, 5);
  assert.equal(notFound.out, '');
  assert.match(notFound.err, /not in the graph/);
});

// --- 10. staleness ---------------------------------------------------------------

test('stale: a graph scanned elsewhere is judged against its own project dir', async () => {
  const { graph, graphPath } = project(path.join(tmpdir(), 'scanned-on-another-machine', 'proj'));
  const card = fileCard(graph, graph.nodes[0], { graphPath });
  assert.equal(card.stale, false, 'src/a.js exists next to .nervegraph and is older than the scan');
});
