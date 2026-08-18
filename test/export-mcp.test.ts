import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toMermaid, toDot, subgraph } from '../src/commands/export.ts';
import { callTool } from '../src/commands/mcp.ts';
import type { Graph } from '../src/graph/types.ts';

const node = (id: string, extra: Record<string, unknown> = {}) => ({
  id, type: 'javascript', lang: 'javascript', size: 1, loc: 1, hash: 'h',
  in: 0, out: 0, risk: 'low', orphan: false, entrypoint: false, ...extra,
});

const GRAPH = {
  schemaVersion: 4, scannedAt: '2026-01-01T00:00:00.000Z',
  nodes: [node('a.js', { entrypoint: true, out: 1 }), node('b.js', { in: 1, deadExports: ['unused'] }), node('c.js')],
  edges: [{ from: 'a.js', to: 'b.js', rel: 'import', line: 2, raw: "import './b.js'" }],
  cycles: [], duplicates: [['a.js', 'c.js']],
} as unknown as Graph;

test('mermaid aliases ids and keeps the relation on the arrow', () => {
  const out = toMermaid(GRAPH, new Set(['a.js', 'b.js']));
  assert.match(out, /^graph LR/);
  assert.match(out, /n0\["a\.js"\]/);
  assert.match(out, /n0 -->\|import\| n1/);
  assert.ok(!out.includes('c.js'), 'a node outside the id set must not be drawn');
});

test('dot marks entrypoints and quotes every id', () => {
  const out = toDot(GRAPH, new Set(['a.js', 'b.js']));
  assert.match(out, /digraph nervegraph \{/);
  assert.match(out, /"a\.js" \[label="a\.js", penwidth=2\]/);
  assert.match(out, /"a\.js" -> "b\.js" \[label="import"\]/);
});

test('subgraph walks both directions and stops at the depth given', () => {
  assert.deepEqual([...subgraph(GRAPH, 'b.js', 1)].sort(), ['a.js', 'b.js']);
  assert.deepEqual([...subgraph(GRAPH, 'b.js', 0)], ['b.js']);
});

test('the MCP tools answer from the same graph', async () => {
  const card = JSON.parse(await callTool(GRAPH, 'nervegraph_query', { file: 'b.js' }));
  assert.equal(card.file, 'b.js');
  assert.deepEqual(card.usedBy, [{ file: 'a.js', rel: 'import', line: 2, raw: "import './b.js'" }]);
  assert.deepEqual(card.deadExports, ['unused']);

  const dupes = JSON.parse(await callTool(GRAPH, 'nervegraph_list', { kind: 'duplicates' }));
  assert.deepEqual(dupes.duplicates, [['a.js', 'c.js']]);

  await assert.rejects(() => callTool(GRAPH, 'nervegraph_query', { file: 'nope.js' }));
  await assert.rejects(() => callTool(GRAPH, 'nervegraph_list', { kind: 'nonsense' }));
});
