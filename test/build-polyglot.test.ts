import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../src/graph/build.ts';
import type { Graph } from '../src/graph/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'polyglot');

let cached: Graph | undefined;
async function graph(): Promise<Graph> {
  cached ??= await buildGraph({ root: FIXTURE, classes: true });
  return cached;
}

const hasEdge = (g: Graph, from: string, to: string, rel?: string) =>
  g.edges.some(e => e.from === from && e.to === to && (rel === undefined || e.rel === rel));

const node = (g: Graph, id: string) => g.nodes.find(n => n.id === id);

test('every language in the fixture is scanned and labelled', async () => {
  const g = await graph();
  const langs = new Map(g.nodes.map(n => [n.id, n.lang]));
  assert.equal(langs.get('app.js'), 'javascript');
  assert.equal(langs.get('index.html'), 'html');
  assert.equal(langs.get('app.css'), 'css');
  assert.equal(langs.get('main.py'), 'python');
  assert.equal(langs.get('lib/thing.rb'), 'ruby');
  assert.equal(langs.get('src/main.rs'), 'rust');
});

test('node types no longer collapse js/py/rb/rs into one grey bucket', async () => {
  const g = await graph();
  assert.equal(node(g, 'app.js')?.type, 'javascript');
  assert.equal(node(g, 'index.html')?.type, 'html');
  assert.equal(node(g, 'main.py')?.type, 'python');
  assert.equal(node(g, 'lib/thing.rb')?.type, 'ruby');
  assert.equal(node(g, 'src/main.rs')?.type, 'rust');
  assert.equal(node(g, 'assets/logo.png')?.type, 'asset');
});

test('html reaches its script, stylesheet and image', async () => {
  const g = await graph();
  assert.ok(hasEdge(g, 'index.html', 'app.js', 'script_src'));
  assert.ok(hasEdge(g, 'index.html', 'app.css', 'link_href'));
  assert.ok(hasEdge(g, 'index.html', 'assets/logo.png', 'asset'));
});

test('a root-absolute script src resolves from the project root', async () => {
  const g = await graph();
  assert.ok(hasEdge(g, 'index.html', 'assets/root.js', 'script_src'));
  assert.equal(node(g, 'assets/root.js')?.missing, undefined);
});

test('commented-out and CDN references produce no edges', async () => {
  const g = await graph();
  assert.ok(!g.edges.some(e => e.to.includes('commented-out')));
  assert.ok(!g.edges.some(e => e.to.includes('cdn.example.com')));
  assert.ok(g.unresolved.some(u => u.from === 'index.html' && u.reason === 'external'));
});

test('python package graph: relative imports and package __init__', async () => {
  const g = await graph();
  assert.ok(hasEdge(g, 'main.py', 'app/views.py', 'py_import'));
  assert.ok(hasEdge(g, 'app/views.py', 'app/models.py', 'py_import'));
  assert.ok(hasEdge(g, 'app/views.py', 'app/__init__.py', 'py_import'));
});

test('a stdlib import creates no node', async () => {
  const g = await graph();
  assert.equal(node(g, 'os'), undefined);
  assert.equal(node(g, 'os.py'), undefined);
});

test('ruby require_relative links, gem require does not', async () => {
  const g = await graph();
  assert.ok(hasEdge(g, 'lib/thing.rb', 'lib/helper.rb', 'rb_require_relative'));
  assert.equal(node(g, 'json.rb'), undefined);
  assert.ok(g.unresolved.some(u => u.from === 'lib/thing.rb' && u.reason === 'external'));
});

test('rust mod chain: crate root -> module -> nested module', async () => {
  const g = await graph();
  assert.ok(hasEdge(g, 'src/main.rs', 'src/parser.rs', 'rust_mod'));
  assert.ok(hasEdge(g, 'src/parser.rs', 'src/parser/lexer.rs', 'rust_mod'));
});

test('css @import and url() both resolve', async () => {
  const g = await graph();
  assert.ok(hasEdge(g, 'app.css', 'base.css', 'css_import'));
  assert.ok(hasEdge(g, 'app.css', 'assets/logo.png', 'asset'));
});

test('entrypoints are recognised across languages', async () => {
  const g = await graph();
  assert.equal(node(g, 'app.js')?.entrypoint, true, 'package.json main');
  assert.equal(node(g, 'index.html')?.entrypoint, true);
  assert.equal(node(g, 'main.py')?.entrypoint, true);
  assert.equal(node(g, 'src/main.rs')?.entrypoint, true);
});

test('a file nothing references and that is not an entrypoint is an orphan', async () => {
  const g = await graph();
  assert.equal(node(g, 'lib/thing.rb')?.orphan, true);
  assert.equal(node(g, 'lib/helper.rb')?.orphan, false);
});

test('no edge points at a node absent from the graph', async () => {
  const g = await graph();
  const ids = new Set(g.nodes.map(n => n.id));
  for (const e of g.edges) {
    assert.ok(ids.has(e.from), `from ${e.from} missing`);
    assert.ok(ids.has(e.to), `to ${e.to} missing`);
  }
});

test('scanning is deterministic', async () => {
  const strip = (g: Graph) => {
    const { scannedAt, durationMs, ...rest } = g;
    return rest;
  };
  const a = await buildGraph({ root: FIXTURE });
  const b = await buildGraph({ root: FIXTURE });
  assert.deepEqual(strip(a), strip(b));
});

test('html classes are collected under --classes', async () => {
  const g = await graph();
  assert.deepEqual(node(g, 'index.html')?.classes?.sort(), ['page', 'page--home']);
});

test('out degree matches the edges actually recorded for the node', async () => {
  const g = await graph();
  for (const n of g.nodes) {
    assert.equal(n.out, g.edges.filter(e => e.from === n.id).length, `out degree wrong for ${n.id}`);
  }
});

test('in degree matches the edges actually pointing at the node', async () => {
  const g = await graph();
  for (const n of g.nodes) {
    assert.equal(n.in, g.edges.filter(e => e.to === n.id).length, `in degree wrong for ${n.id}`);
  }
});
