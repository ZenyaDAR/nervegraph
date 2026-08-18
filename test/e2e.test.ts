import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { runScan } from '../src/commands/scan.ts';
import { runQuery } from '../src/commands/query.ts';
import { createServer } from '../src/server.ts';

// The one test that runs the product the way a user does: scan a fixture,
// query the artifact, serve it over HTTP. Both 0.3.1 bugs lived in exactly the
// stretch no unit test covered — the server's routing and the viewer's assets.

const FIXTURE = fileURLToPath(new URL('./fixtures/polyglot', import.meta.url));

async function silently<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log, err = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await fn(); } finally { console.log = log; console.error = err; }
}

test('scan → query → view works end to end', async (t) => {
  const out = mkdtempSync(path.join(tmpdir(), 'nervegraph-e2e-'));
  const graphPath = path.join(out, 'graph.json');

  const scanCode = await silently(() => runScan({ path: FIXTURE, out, quiet: true }));
  assert.equal(scanCode, 0);

  // Compact by default: no indentation means no newline-plus-spaces runs.
  const raw = readFileSync(graphPath, 'utf8');
  assert.ok(!raw.includes('\n  '), 'graph.json should be compact unless --pretty');
  const graph = JSON.parse(raw);
  assert.ok(graph.nodes.length > 0);
  assert.ok(Array.isArray(graph.cycles), 'schema 4 carries cycles as data');

  await t.test('query answers from that artifact', async () => {
    const chunks: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => { chunks.push(a.join(' ')); };
    let code: number;
    try {
      code = await runQuery({ file: 'util.js', graph: graphPath, json: true });
    } finally { console.log = log; }
    assert.equal(code, 0);
    const card = JSON.parse(chunks.join('\n'));
    assert.equal(card.file, 'util.js');
  });

  await t.test('the server serves the viewer, the graph, and nothing else', async () => {
    const server = createServer(graphPath);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const get = (p: string) => fetch(`http://127.0.0.1:${port}${p}`);
    try {
      assert.equal((await get('/')).status, 200);
      // A cache-busting query string must not miss the allowlist (0.3.1 bug).
      assert.equal((await get('/app.css?v=2')).status, 200);
      assert.equal((await (await get('/graph.json')).json() as any).schemaVersion, graph.schemaVersion);
      assert.equal((await get('/../package.json')).status, 404);
      assert.equal((await get('/etc/passwd')).status, 404);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

test('--pretty brings the indentation back', async () => {
  const out = mkdtempSync(path.join(tmpdir(), 'nervegraph-e2e-pretty-'));
  await silently(() => runScan({ path: FIXTURE, out, quiet: true, pretty: true }));
  assert.ok(readFileSync(path.join(out, 'graph.json'), 'utf8').includes('\n  '));
});
