import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../src/graph/build.ts';
import { classifyNodeType, isEntrypoint } from '../src/scan/profile.ts';
import { langFor, TEXT_EXT } from '../src/scan/extensions.ts';
import { SCHEMA_VERSION } from '../src/graph/types.ts';
import { VERSION } from '../src/version.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(__dirname, 'fixtures', name);

test('a dependency cycle is reported with the files involved, not just "detected"', async () => {
  const g = await buildGraph({ root: fixture('cycle') });
  const cycles = g.warnings.filter(w => w.code === 'cycle');
  assert.equal(cycles.length, 1);
  // Names every file on the cycle, so the warning is actionable.
  for (const f of ['a.js', 'b.js', 'c.js']) {
    assert.ok(cycles[0].message.includes(f), `cycle message should name ${f}: ${cycles[0].message}`);
  }
  assert.ok(cycles[0].file, 'cycle warning should point at a file');
});

test('an acyclic project reports no cycle', async () => {
  const g = await buildGraph({ root: fixture('polyglot') });
  assert.deepEqual(g.warnings.filter(w => w.code === 'cycle'), []);
});

test('several names imported from one module on one line collapse to a single edge', async () => {
  const g = await buildGraph({ root: fixture('polyglot') });
  const edges = g.edges.filter(e => e.from === 'app/dedupe.py' && e.to === 'app/models.py');
  assert.equal(edges.length, 1, 'from .models import User, Other should be one edge');
});

test('graph metadata reports the real version and schema', async () => {
  const g = await buildGraph({ root: fixture('cycle') });
  assert.equal(g.tool, `nervegraph@${VERSION}`);
  assert.equal(g.schemaVersion, SCHEMA_VERSION);
});

test('langFor covers every extension the collector reads as text', () => {
  for (const ext of TEXT_EXT) {
    assert.notEqual(langFor(`file${ext}`), 'other', `${ext} is read as text but has no language`);
  }
});

test('extension classification is case-insensitive', () => {
  assert.equal(langFor('A.PY'), 'python');
  assert.equal(classifyNodeType('A.RS', 'js'), 'rust');
});

test('shopify directory conventions still outrank extension rules', () => {
  assert.equal(classifyNodeType('sections/main.liquid', 'shopify'), 'section');
  assert.equal(classifyNodeType('snippets/card.liquid', 'shopify'), 'snippet');
  assert.equal(classifyNodeType('templates/product.json', 'shopify'), 'template_json');
  // ...but a JS file in a theme is still javascript, not a shopify type
  assert.equal(classifyNodeType('assets/theme.js', 'shopify'), 'javascript');
});

test('images and vectors are assets wherever they live', () => {
  assert.equal(classifyNodeType('media/hero.png', 'js'), 'asset');
  assert.equal(classifyNodeType('icons/logo.svg', 'js'), 'asset');
  assert.equal(classifyNodeType('assets/font.woff2', 'js'), 'asset');
});

test('entrypoint conventions per language', () => {
  const entry = (id: string) => isEntrypoint(id, 'js');
  assert.ok(entry('index.html'));
  assert.ok(entry('src/index.ts'));
  assert.ok(entry('src/main.rs'));
  assert.ok(entry('src/lib.rs'));
  assert.ok(entry('src/bin/tool.rs'));
  assert.ok(entry('manage.py'));
  assert.ok(entry('app/__main__.py'));
  assert.ok(entry('config/application.rb'));
  // Ordinary files are not entrypoints, or everything would look reachable.
  assert.ok(!entry('src/parser.rs'));
  assert.ok(!entry('app/models.py'));
  assert.ok(!entry('lib/helper.rb'));
  assert.ok(!entry('about.html'));
});

test('package.json main/bin/exports still mark entrypoints', () => {
  assert.ok(isEntrypoint('app.js', 'js', { main: './app.js' }));
  assert.ok(isEntrypoint('cli.js', 'js', { bin: { tool: 'cli.js' } }));
  assert.ok(isEntrypoint('lib/x.js', 'js', { exports: { '.': './lib/x.js' } }));
});
