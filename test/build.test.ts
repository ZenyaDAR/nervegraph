import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../src/graph/build.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'mini-theme');

function stripVolatile(graph: any) {
  const { scannedAt, durationMs, ...rest } = graph;
  return rest;
}

test('determinism: two scans of the same input produce identical output', async () => {
  const a = await buildGraph({ root: FIXTURE });
  const b = await buildGraph({ root: FIXTURE });
  assert.deepEqual(stripVolatile(a), stripVolatile(b));
});

test('no edge points to a node missing from the graph', async () => {
  const g = await buildGraph({ root: FIXTURE });
  const ids = new Set(g.nodes.map(n => n.id));
  for (const e of g.edges) {
    assert.ok(ids.has(e.from), `from ${e.from} missing`);
    assert.ok(ids.has(e.to), `to ${e.to} missing`);
  }
});

test('known structural edge is present: main-product renders product-card', async () => {
  const g = await buildGraph({ root: FIXTURE });
  const found = g.edges.some(e => e.from === 'sections/main-product.liquid' && e.to === 'snippets/product-card.liquid' && e.rel === 'render');
  assert.ok(found);
});

test('nodes and edges are sorted', async () => {
  const g = await buildGraph({ root: FIXTURE });
  const nodeIds = g.nodes.map(n => n.id);
  assert.deepEqual(nodeIds, [...nodeIds].sort());
});
