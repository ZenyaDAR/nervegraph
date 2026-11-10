import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildGraph } from '../src/graph/build.ts';
import { importedNames } from '../src/scan/scanners/javascript.ts';
import { findDuplicates, foldToPackages } from '../src/graph/analysis.ts';
import { collectViolations, checkRules, globToRegExp } from '../src/commands/check.ts';
import { diffGraphs } from '../src/commands/diff.ts';
import { collectChurn, hotThreshold } from '../src/scan/git.ts';
import type { Graph, GraphNode } from '../src/graph/types.ts';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nervegraph-analysis-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function node(g: Graph, id: string): GraphNode | undefined {
  return g.nodes.find(n => n.id === id);
}

test('importedNames reads the bindings out of a statement', () => {
  assert.deepEqual(importedNames("import { a, b as c } from './x.js'"), ['a', 'b']);
  assert.deepEqual(importedNames("import d from './x.js'"), ['default']);
  assert.deepEqual(importedNames("import d, { a } from './x.js'"), ['default', 'a']);
  assert.deepEqual(importedNames("import * as ns from './x.js'"), ['*']);
  assert.deepEqual(importedNames("export * from './x.js'"), ['*']);
  assert.deepEqual(importedNames("export { a } from './x.js'"), ['a']);
  assert.deepEqual(importedNames("import type { T } from './x.js'"), ['T']);
  assert.deepEqual(importedNames("import './x.js'"), []);
});

test('an export nobody imports is reported dead', async () => {
  const root = project({
    'package.json': '{"name":"t","main":"main.js"}',
    'main.js': "import { used } from './lib.js';\nconsole.log(used);\n",
    'lib.js': 'export const used = 1;\nexport const unused = 2;\n',
  });
  const g = await buildGraph({ root });
  assert.deepEqual(node(g, 'lib.js')?.deadExports, ['unused']);
});

test('a namespace import makes usage unknowable, so nothing is called dead', async () => {
  const root = project({
    'package.json': '{"name":"t","main":"main.js"}',
    'main.js': "import * as lib from './lib.js';\nconsole.log(lib);\n",
    'lib.js': 'export const a = 1;\nexport const b = 2;\n',
  });
  const g = await buildGraph({ root });
  assert.equal(node(g, 'lib.js')?.deadExports, undefined);
});

test('an entrypoint keeps its public surface', async () => {
  const root = project({
    'package.json': '{"name":"t","main":"index.js"}',
    'index.js': 'export const api = 1;\n',
  });
  const g = await buildGraph({ root });
  assert.equal(node(g, 'index.js')?.deadExports, undefined);
});

test('byte-identical files are grouped, empty ones are not', () => {
  const n = (id: string, hash: string, loc = 3): GraphNode => ({
    id, type: 'javascript', lang: 'javascript', size: 1, loc, hash,
    in: 0, out: 0, risk: 'low', orphan: false, entrypoint: false,
  });
  assert.deepEqual(
    findDuplicates([n('b.js', 'aaa'), n('a.js', 'aaa'), n('c.js', 'bbb'), n('d.js', '', 0)]),
    [['a.js', 'b.js']],
  );
});

test('check fails on a broken reference by default and passes when told to allow it', () => {
  const graph = {
    stats: { files: 1, edges: 0, unresolved: 0, orphans: 0, byType: {} },
    nodes: [{ id: 'gone.js', missing: true }],
    unresolved: [], cycles: [], duplicates: [],
  } as unknown as Graph;

  assert.equal(collectViolations(graph, {}).length, 1);
  assert.equal(collectViolations(graph, { allowMissing: true }).length, 0);
});

test('churn is optional: no git repo, no churn, no crash', () => {
  const root = project({ 'a.js': 'export const a = 1;\n' });
  assert.equal(collectChurn(root).size, 0);
  assert.equal(hotThreshold(new Map()), Infinity);
  // Floored at 5 so a young repo doesn't call everything hot.
  assert.equal(hotThreshold(new Map([['a', 1], ['b', 2], ['c', 3], ['d', 4]])), 5);
  assert.equal(hotThreshold(new Map([['a', 1], ['b', 8], ['c', 9], ['d', 40]])), 9);
});

test('diff names what changed structurally', () => {
  const node = (id: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'javascript', lang: 'javascript', size: 1, loc: 1, hash: 'h',
    in: 0, out: 0, risk: 'low', orphan: false, entrypoint: false, ...extra,
  });
  const before = {
    nodes: [node('a.js'), node('b.js', { risk: 'low' })],
    edges: [{ from: 'a.js', to: 'b.js', rel: 'import', line: 1, raw: '' }],
    cycles: [],
  } as unknown as Graph;
  const after = {
    nodes: [node('a.js', { orphan: true }), node('b.js', { risk: 'high' }), node('c.js')],
    edges: [{ from: 'b.js', to: 'c.js', rel: 'import', line: 1, raw: '' }],
    cycles: [['b.js', 'c.js', 'b.js']],
  } as unknown as Graph;

  const d = diffGraphs(before, after);
  assert.deepEqual(d.files.added, ['c.js']);
  assert.deepEqual(d.files.removed, []);
  assert.deepEqual(d.edges.added, ['b.js → c.js (import)']);
  assert.deepEqual(d.edges.removed, ['a.js → b.js (import)']);
  assert.deepEqual(d.cycles.added, ['b.js -> c.js -> b.js']);
  assert.deepEqual(d.orphaned, ['a.js']);
  assert.deepEqual(d.riskUp, [{ file: 'b.js', from: 'low', to: 'high' }]);
});

test('check budgets only fire when set', () => {
  const graph = {
    stats: { files: 2, edges: 2, unresolved: 3, orphans: 1, byType: {} },
    nodes: [{ id: 'a.js', orphan: true, deadExports: ['x'] }, { id: 'test/a.test.js', orphan: true }],
    unresolved: [
      { from: 'a.js', line: 1, rel: 'import', raw: "import 'x'", reason: 'external', hint: '' },
      { from: 'a.js', line: 2, rel: 'import', raw: "import(x)", reason: 'dynamic', hint: '' },
    ],
    cycles: [['a.js', 'b.js', 'a.js']],
    duplicates: [['a.js', 'b.js']],
  } as unknown as Graph;

  assert.deepEqual(collectViolations(graph, {}), []);
  assert.equal(collectViolations(graph, { maxCycles: 0 })[0].rule, 'cycles');
  assert.equal(collectViolations(graph, { maxCycles: 1 }).length, 0);
  // external refs (npm, builtins) and non-code orphans (tests) are not counted
  assert.equal(collectViolations(graph, { maxUnresolved: 0 })[0].actual, 1);
  assert.equal(collectViolations(graph, { maxUnresolved: 1 }).length, 0);
  assert.equal(collectViolations(graph, { maxOrphans: 0 })[0].actual, 1);
  assert.equal(collectViolations(graph, { maxOrphans: 0 })[0].rule, 'orphan code files');
  assert.equal(collectViolations(graph, { noDeadExports: true })[0].rule, 'files with unused exports');
  assert.equal(collectViolations(graph, { noDuplicates: true })[0].rule, 'duplicate file groups');
});

test('a liquid variable assigned one literal resolves; an ambiguous one does not', async () => {
  const root = project({
    'config/settings_schema.json': '[]',
    'layout/theme.liquid': [
      "{% assign card = 'product-card' %}",
      '{% render card %}',
      "{% assign other = 'price' %}",
      "{% assign other = 'money' %}",
      '{% render other %}',
    ].join('\n'),
    'snippets/product-card.liquid': '<div></div>\n',
    'snippets/price.liquid': '<span></span>\n',
    'snippets/money.liquid': '<span></span>\n',
  });
  const g = await buildGraph({ root, noGit: true });
  assert.deepEqual(
    g.edges.filter(e => e.rel === 'render').map(e => e.to),
    ['snippets/product-card.liquid'],
  );
  assert.equal(g.unresolved.filter(u => u.reason === 'dynamic').length, 1);
});

test('a custom element in markup links to the file that defines it', async () => {
  const root = project({
    'config/settings_schema.json': '[]',
    'sections/main-product.liquid': '<product-form></product-form>\n<unknown-thing></unknown-thing>\n',
    'assets/product-form.js': "customElements.define('product-form', class extends HTMLElement {});\n",
  });
  const g = await buildGraph({ root, noGit: true });
  const edge = g.edges.find(e => e.rel === 'custom_element');
  assert.equal(edge?.from, 'sections/main-product.liquid');
  assert.equal(edge?.to, 'assets/product-form.js');
  // An element nothing in the project defines is reported, not invented.
  assert.ok(g.unresolved.some(u => u.rel === 'custom_element' && u.raw.includes('unknown-thing')));
});

test('the package fold turns a monorepo into one node per package', async () => {
  const root = project({
    'package.json': '{"name":"root","workspaces":["packages/*"]}',
    'packages/ui/package.json': '{"name":"ui"}',
    'packages/core/package.json': '{"name":"core"}',
    'packages/ui/index.js': "import { core } from '../core/index.js';\nexport const ui = core;\n",
    'packages/core/index.js': 'export const core = 1;\n',
  });
  const g = await buildGraph({ root, noGit: true });
  const folded = foldToPackages(g);
  assert.deepEqual(folded.edges, [{ from: 'packages/ui', to: 'packages/core', count: 1 }]);
  assert.deepEqual(folded.packages.map(p => p.id), ['(root)', 'packages/core', 'packages/ui']);
});

test('layer rules catch the edge the user forbade', () => {
  const graph = {
    nodes: [], cycles: [], duplicates: [], unresolved: [],
    stats: { files: 2, edges: 2, unresolved: 0, orphans: 0, byType: {} },
    edges: [
      { from: 'src/ui/page.js', to: 'src/db/client.js', rel: 'import', line: 3, raw: '' },
      { from: 'src/ui/page.js', to: 'src/lib/fmt.js', rel: 'import', line: 4, raw: '' },
    ],
  } as unknown as Graph;

  const denied = checkRules(graph, [{ name: 'ui must not reach db', from: 'src/ui/**', deny: 'src/db/**' }]);
  assert.equal(denied.length, 1);
  assert.deepEqual(denied[0].detail, ['src/ui/page.js:3 → src/db/client.js']);

  const allowed = checkRules(graph, [{ from: 'src/ui/**', allow: 'src/lib/**' }]);
  assert.equal(allowed[0].actual, 1); // the db import is the one outside the allowlist
  assert.equal(globToRegExp('src/*.js').test('src/a/b.js'), false);
});
