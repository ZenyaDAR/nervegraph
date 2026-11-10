import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildGraph } from '../src/graph/build.ts';
import { collectFiles } from '../src/scan/files.ts';
import { collectChurn } from '../src/scan/git.ts';
import { loadAliases, loadPsr4, expandAlias } from '../src/scan/aliases.ts';
import { scanJavaScript } from '../src/scan/scanners/javascript.ts';
import type { Graph } from '../src/graph/types.ts';

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nervegraph-fixcore-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const scan = (root: string) => buildGraph({ root, noGit: true });
const edge = (g: Graph, from: string, to: string) => g.edges.find(e => e.from === from && e.to === to);
const node = (g: Graph, id: string) => g.nodes.find(n => n.id === id);

test('1: a .js specifier resolves to the .ts/.cts source, also through package imports', async () => {
  const g = await scan(project({
    'package.json': JSON.stringify({ imports: { '#lib/*': './src/lib/*.js' } }),
    'src/main.ts': "import './util.js';\nimport './c.cjs';\nimport '#lib/money';\n",
    'src/util.ts': 'export const u = 1;\n',
    'src/c.cts': 'export const c = 1;\n',
    'src/lib/money.ts': 'export const m = 1;\n',
  }));
  assert.ok(edge(g, 'src/main.ts', 'src/util.ts'));
  assert.ok(edge(g, 'src/main.ts', 'src/c.cts'));
  assert.ok(edge(g, 'src/main.ts', 'src/lib/money.ts'));
  assert.ok(!g.nodes.some(n => n.missing));
});

test('2: TS export declarations get their real names, keyword garbage is dropped', () => {
  const r = scanJavaScript({
    id: 'a.ts',
    content: [
      'export abstract class Abs {}',
      'export declare const D: number;',
      'export const enum CE { A }',
      'export enum E { A }',
      'export type T = string;',
      'export interface I {}',
      'export namespace NS {}',
      'export function f() {}',
      "export type { Y, Z as W } from './y';",
      '// export const commented = 1;',
    ].join('\n'),
  });
  for (const name of ['Abs', 'D', 'CE', 'E', 'T', 'I', 'NS', 'f', 'Y', 'W']) {
    assert.ok(r.exports?.includes(name), `missing export ${name}`);
  }
  for (const junk of ['s', 'declare', 'enum', 'commented']) {
    assert.ok(!r.exports?.includes(junk), `junk export ${junk}`);
  }
  // es-module-lexer drops `export type { … } from` entirely; the edge stays.
  const y = r.refs.find(ref => ref.target === './y');
  assert.deepEqual(y?.names, ['Y', 'Z']);
});

test('3: require() inside comments and strings is not an edge', () => {
  const r = scanJavaScript({
    id: 'a.js',
    content: [
      "// require('./line-comment')",
      "/* require('./block-comment') */",
      "const s = \"require('./in-string')\";",
      'const t = `require("./in-template")`;',
      'const re = /require\\("x"\\)/;',
      "const real = require('./real');",
    ].join('\n'),
  });
  assert.deepEqual(r.refs.filter(ref => ref.rel === 'require').map(ref => [ref.target, ref.line]), [['./real', 6]]);
});

test('4: output order is deterministic and code-unit sorted', async () => {
  const names = ['b.js', 'Bb.js', 'a.js', 'Z.js', '_x.js'];
  const files: Record<string, string> = { 'main.js': names.map(n => `import './${n}';`).join('\n') };
  // Every file defines the same tag: the definer picked must not vary per run.
  for (const n of names) files[n] = "customElements.define('x-el', class {});\n";
  const root = project(files);
  const { files: scanned } = await collectFiles(root);
  const ids = scanned.map(f => f.id);
  assert.deepEqual(ids, [...ids].sort());
  const g1 = await scan(root);
  const g2 = await scan(root);
  const strip = (g: Graph) => JSON.stringify({ ...g, scannedAt: '', durationMs: 0 });
  assert.equal(strip(g1), strip(g2));
  const tos = g1.edges.map(e => e.to);
  assert.deepEqual(tos, [...tos].sort());
  assert.equal(tos[0], 'Bb.js'); // 'B' < '_' < 'a' in code units, unlike localeCompare
});

test('5a: tsconfig paths pick the most specific pattern and follow extends', () => {
  const root = project({
    'tsconfig.base.json': JSON.stringify({
      compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'], '@/components/*': ['ui/components/*'] } },
    }),
    'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json', compilerOptions: { strict: true } }),
  });
  const rules = loadAliases(root);
  assert.equal(expandAlias('@/components/Button', rules)[0], 'ui/components/Button');
  assert.equal(expandAlias('@/lib/x', rules)[0], 'src/lib/x');
});

test('5b: a child tsconfig overrides paths and a package-name extends is followed', () => {
  const root = project({
    'node_modules/@acme/tsconfig/base.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['nope/*'] } } }),
    'tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig/base.json', compilerOptions: { baseUrl: '.', paths: { '~/*': ['src/*'] } } }),
  });
  assert.equal(expandAlias('~/a', loadAliases(root))[0], 'src/a');

  const inherited = project({
    'node_modules/@acme/tsconfig/tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '#/*': ['lib/*'] } } }),
    'tsconfig.json': JSON.stringify({ extends: '@acme/tsconfig' }),
  });
  // `paths` without baseUrl is relative to the config that declares it.
  assert.equal(expandAlias('#/a', loadAliases(inherited))[0], 'node_modules/@acme/tsconfig/lib/a');
});

test('5c: workspace packages honour exports subpaths and main', async () => {
  const g = await scan(project({
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/ui/package.json': JSON.stringify({
      name: '@app/ui',
      exports: { '.': { import: './dist/index.js', types: './src/entry.ts' }, './button': './src/btn/button.ts' },
    }),
    'packages/ui/src/entry.ts': 'export const ui = 1;\n',
    'packages/ui/src/btn/button.ts': 'export const b = 1;\n',
    'packages/core/package.json': JSON.stringify({ name: '@app/core', main: 'lib/core.js' }),
    'packages/core/lib/core.js': 'export const c = 1;\n',
    'app.ts': "import '@app/ui';\nimport '@app/ui/button';\nimport '@app/core';\n",
  }));
  assert.ok(edge(g, 'app.ts', 'packages/ui/src/entry.ts'));
  assert.ok(edge(g, 'app.ts', 'packages/ui/src/btn/button.ts'));
  assert.ok(edge(g, 'app.ts', 'packages/core/lib/core.js'));
});

test('5d: a go.mod below the root resolves imports of the files under it', async () => {
  const g = await scan(project({
    'svc/go.mod': 'module example.com/svc\n\ngo 1.22\n',
    'svc/main.go': 'package main\n\nimport "example.com/svc/internal/db"\n',
    'svc/internal/db/db.go': 'package db\n',
  }));
  assert.ok(edge(g, 'svc/main.go', 'svc/internal/db/db.go'));
});

test('5e: PSR-0 keeps the namespace path under the directory', () => {
  const root = project({ 'composer.json': JSON.stringify({ autoload: { 'psr-0': { 'Acme\\': 'src/' } } }) });
  assert.deepEqual(expandAlias('Acme/Util/Str', loadPsr4(root)), ['src/Acme/Util/Str']);
});

test('6: dot-directories are scanned, gitignored files exist, nested .gitignore applies', async () => {
  const root = project({
    '.gitignore': 'generated.js\n',
    '.storybook/main.js': "import '../src/a.js';\n",
    'src/a.js': "import '../generated.js';\nimport './gen/out.js';\n",
    'src/.gitignore': 'gen/\n',
    'src/gen/out.js': 'export {};\n',
    'generated.js': 'export {};\n',
    'other/gen/kept.js': 'export {};\n',
  });
  const { files } = await collectFiles(root);
  const ids = files.map(f => f.id);
  assert.ok(ids.includes('.storybook/main.js'));
  assert.ok(!ids.includes('src/gen/out.js'));
  assert.ok(ids.includes('other/gen/kept.js'), 'src/.gitignore must not apply outside src/');
  const g = await scan(root);
  assert.ok(edge(g, '.storybook/main.js', 'src/a.js'));
  assert.ok(edge(g, 'src/a.js', 'generated.js'));
  assert.ok(edge(g, 'src/a.js', 'src/gen/out.js'));
  assert.equal(node(g, 'generated.js')?.missing, undefined);
  assert.equal(node(g, 'src/gen/out.js')?.missing, undefined);
});

test('7: identical edges on one line merge their imported names', async () => {
  const g = await scan(project({
    'main.js': "import { a } from './x.js'; import { b } from './x.js';\nconsole.log(a, b);\n",
    'x.js': 'export const a = 1;\nexport const b = 2;\nexport const c = 3;\n',
  }));
  const edges = g.edges.filter(e => e.from === 'main.js' && e.to === 'x.js');
  assert.equal(edges.length, 1);
  assert.deepEqual(edges[0].names, ['a', 'b']);
  assert.deepEqual(node(g, 'x.js')?.deadExports, ['c']);
});

test('8: churn matches non-ASCII paths', (t) => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { t.skip('git not installed'); return; }
  const root = project({ 'файл.js': 'x\n' });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'init');
  assert.equal(collectChurn(root).get('файл.js'), 1);
});

test('9: import "./" and "." resolve to the directory index', async () => {
  const g = await scan(project({
    'src/a.js': "import './';\n",
    'src/index.js': 'export {};\n',
    'main.js': "import '.';\n",
    'index.js': 'export {};\n',
  }));
  assert.ok(edge(g, 'src/a.js', 'src/index.js'));
  assert.ok(edge(g, 'main.js', 'index.js'));
  assert.ok(!g.nodes.some(n => n.missing));
});

test('10: a case-insensitive-only match keeps the edge and warns', async () => {
  const g = await scan(project({
    'main.js': "import './Util.js';\nimport './other.js';\n",
    'util.js': 'export {};\n',
    'other.js': 'export {};\n',
  }));
  assert.ok(edge(g, 'main.js', 'util.js'));
  const warned = g.warnings.filter(w => w.file === 'main.js' && /case-insensitive/.test(w.message));
  assert.equal(warned.length, 1);
  assert.match(warned[0].message, /Util\.js/);
});
