import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runQuery } from '../src/commands/query.ts';

function graphFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'nervegraph-query-'));
  const root = path.join(dir, 'proj');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'util.js'), 'export const x = 1;\n');

  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'javascript', lang: 'javascript', size: 10, loc: 2, hash: 'abc',
    in: 0, out: 0, risk: 'low', orphan: false, entrypoint: false, ...extra,
  });
  const graph = {
    schemaVersion: 3,
    tool: 'nervegraph@test',
    root,
    profile: 'js',
    scannedAt: new Date(Date.now() + 60_000).toISOString(), // in the future: nothing is stale
    durationMs: 1,
    stats: { files: 3, edges: 2, unresolved: 1, orphans: 1, byType: {} },
    nodes: [
      node('src/util.js', { in: 1, risk: 'medium' }),
      node('src/a.js', { out: 1, in: 1 }),
      node('src/entry.js', { out: 1, entrypoint: true, risk: 'high' }),
      node('src/gone.js', { missing: true, in: 1 }),
      node('src/dead.js', { orphan: true }),
    ],
    edges: [
      { from: 'src/a.js', to: 'src/util.js', rel: 'import', line: 1, raw: "import './util.js'" },
      { from: 'src/entry.js', to: 'src/a.js', rel: 'import', line: 1, raw: "import './a.js'" },
    ],
    unresolved: [{ from: 'src/a.js', line: 3, rel: 'import', raw: "import 'lodash'", reason: 'external', hint: 'npm package' }],
    warnings: [],
  };
  const file = path.join(dir, 'graph.json');
  writeFileSync(file, JSON.stringify(graph));
  return file;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const real = console.log;
  const realErr = console.error;
  console.log = (...a: unknown[]) => { chunks.push(a.join(' ')); };
  console.error = () => {};
  try {
    const code = await fn();
    return { code, out: chunks.join('\n') };
  } finally {
    console.log = real;
    console.error = realErr;
  }
}

const GRAPH = graphFile();

test('the file card counts transitive dependents, not just direct ones', async () => {
  const { code, out } = await capture(() => runQuery({ file: 'src/util.js', graph: GRAPH, json: true }));
  assert.equal(code, 0);
  const card = JSON.parse(out);
  assert.equal(card.file, 'src/util.js');
  assert.equal(card.counts.in, 1);
  // a.js imports util, entry imports a — both are in the blast radius.
  assert.equal(card.transitiveDependents, 2);
  assert.deepEqual(card.usedBy.map((r: any) => r.file), ['src/a.js']);
  assert.equal(card.stale, false);
});

test('--json prints nothing but JSON, so it is pipe-safe', async () => {
  const { out } = await capture(() => runQuery({ file: 'src/a.js', graph: GRAPH, json: true }));
  assert.doesNotThrow(() => JSON.parse(out));
});

test('--depth lists the neighbourhood', async () => {
  const { out } = await capture(() => runQuery({ file: 'src/util.js', graph: GRAPH, json: true, depth: 2 }));
  assert.deepEqual(JSON.parse(out).neighbors, ['src/a.js', 'src/entry.js']);
});

test('list forms filter the node set', async () => {
  const orphans = JSON.parse((await capture(() => runQuery({ graph: GRAPH, json: true, orphans: true }))).out);
  assert.deepEqual(orphans.files.map((f: any) => f.file), ['src/dead.js']);

  const missing = JSON.parse((await capture(() => runQuery({ graph: GRAPH, json: true, missing: true }))).out);
  assert.deepEqual(missing.files.map((f: any) => f.file), ['src/gone.js']);

  const high = JSON.parse((await capture(() => runQuery({ graph: GRAPH, json: true, risk: 'high' }))).out);
  assert.deepEqual(high.files.map((f: any) => f.file), ['src/entry.js']);

  const unresolved = JSON.parse((await capture(() => runQuery({ graph: GRAPH, json: true, unresolved: true }))).out);
  assert.equal(unresolved.unresolved[0].reason, 'external');
});

test('a file outside the graph is an error, not an empty card', async () => {
  const { code } = await capture(() => runQuery({ file: 'src/nope.js', graph: GRAPH, json: true }));
  assert.equal(code, 5);
});

test('a missing graph tells the caller to scan', async () => {
  const { code } = await capture(() => runQuery({ file: 'a.js', graph: path.join(tmpdir(), 'no-such-graph.json') }));
  assert.equal(code, 5);
});
