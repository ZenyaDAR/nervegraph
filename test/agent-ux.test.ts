import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../src/graph/build.ts';
import { resolveGraphPath, writeGraphAtomic } from '../src/graph/io.ts';
import { fileKind } from '../src/graph/analysis.ts';
import { editDistance, fileCard, lookupFailureMessage, lookupNode, staleFiles, symbolReport } from '../src/commands/query.ts';
import { overview } from '../src/commands/overview.ts';
import { handleLine, INSTRUCTIONS, instructionsFor, TOOLS } from '../src/commands/mcp.ts';

// What an agent needs from the tool beyond a correct graph: finding it from
// wherever it runs, a graph that is never stale, answers it can act on without
// a follow-up grep, and failures that say what to try instead.

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const cli = (args: string[], cwd: string) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], { encoding: 'utf8', timeout: 60_000, cwd });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nervegraph-ux-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

// a.ts <- b.ts <- c.ts <- test/c.test.ts, and a style sheet nothing imports.
const chain = () => project({
  'package.json': '{}',
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': "import { a } from './a';\nexport const b = a;\n",
  'src/c.ts': "import { b } from './b';\nexport const c = b;\n",
  'test/c.test.ts': "import { c } from '../src/c';\n",
});

test('resolveGraphPath: the nearest graph upward, stopping at the repository root', () => {
  const root = project({ '.git/HEAD': '', 'src/deep/x.ts': '' });
  const sub = path.join(root, 'src', 'deep');
  assert.equal(resolveGraphPath(undefined, sub), path.join(root, '.nervegraph', 'graph.json'), 'no graph yet: the repo root is where to scan');
  mkdirSync(path.join(root, 'src', '.nervegraph'));
  writeFileSync(path.join(root, 'src', '.nervegraph', 'graph.json'), '{}');
  assert.equal(resolveGraphPath(undefined, sub), path.join(root, 'src', '.nervegraph', 'graph.json'), 'a nearer graph wins');
  assert.equal(resolveGraphPath('g.json', sub), path.resolve('g.json'), '--graph is taken as given');
});

test('CLI query from a subdirectory scans the project root on first use, then follows edits', () => {
  const root = chain();
  mkdirSync(path.join(root, '.git'));
  const first = cli(['query', 'a.ts', '--json'], path.join(root, 'src'));
  assert.equal(first.code, 0, first.err);
  assert.match(first.err, /no graph .*scanning/);
  assert.ok(existsSync(path.join(root, '.nervegraph', 'graph.json')));
  assert.deepEqual(JSON.parse(first.out).usedBy.map((u: any) => u.file), ['src/b.ts']);

  // A new importer appears after the scan: the next query re-scans and lists it.
  const old = new Date(Date.now() - 3_600_000);
  for (const f of ['package.json', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'test/c.test.ts']) utimesSync(path.join(root, f), old, old);
  writeFileSync(path.join(root, 'src', 'd.ts'), "import { a } from './a';\n");
  const second = cli(['query', 'src/a.ts', '--json'], root);
  assert.equal(second.code, 0, second.err);
  assert.deepEqual(JSON.parse(second.out).usedBy.map((u: any) => u.file), ['src/b.ts', 'src/d.ts']);

  const off = cli(['query', 'src/a.ts', '--json', '--no-autoscan'], project({ 'x.ts': '' }));
  assert.equal(off.code, 5, 'no graph and no autoscan: the old "run nerve scan" answer');
});

test('file card: indirect dependents grouped by type, counts by type, tests', async () => {
  const g = await buildGraph({ root: chain(), noGit: true });
  const card = fileCard(g, g.nodes.find(n => n.id === 'src/a.ts')!);
  assert.deepEqual(card.usedBy.map(u => u.file), ['src/b.ts']);
  assert.deepEqual(card.indirectDependents, { javascript: ['src/c.ts', 'test/c.test.ts'] }, 'direct dependents are not repeated');
  assert.deepEqual(card.affectedByType, { javascript: 3 });
  assert.deepEqual(card.tests, ['test/c.test.ts']);
  const capped = fileCard(g, g.nodes.find(n => n.id === 'src/a.ts')!, { limit: 1 });
  assert.deepEqual(capped.indirectDependents, { javascript: ['src/c.ts'] });
  assert.deepEqual(capped.truncated, { 'indirectDependents.javascript': 1 });
});

test('file card: each type is capped on its own, so a big group cannot hide a small one', async () => {
  const files: Record<string, string> = { 'package.json': '{}', 'src/core.ts': 'export const x = 1;\n', 'src/mid.ts': "import { x } from './core';\nexport const y = x;\n" };
  for (let i = 0; i < 5; i++) files[`src/m${i}.ts`] = "import { y } from './mid';\n";
  files['page.html'] = '<script type="module" src="src/m0.ts"></script>';
  const g = await buildGraph({ root: project(files), noGit: true });
  const card = fileCard(g, g.nodes.find(n => n.id === 'src/core.ts')!, { limit: 2 });
  assert.deepEqual(Object.keys(card.indirectDependents), ['html', 'javascript']);
  assert.equal(card.indirectDependents.javascript.length, 2);
  assert.equal(card.truncated?.['indirectDependents.javascript'], 3);
});

test('lookup: a directory lists its files, a typo gets the closest names', async () => {
  const g = await buildGraph({ root: chain(), noGit: true });
  const dir = lookupNode(g, 'src/');
  assert.deepEqual(dir.suggestions, { directory: true, files: ['src/a.ts', 'src/b.ts', 'src/c.ts'] });
  assert.match(lookupFailureMessage(dir), /src\/ is a directory of 3 files/);
  const typo = lookupNode(g, 'src/bb.ts');
  assert.deepEqual(typo.suggestions?.files.slice(0, 1), ['src/b.ts']);
  assert.match(lookupFailureMessage(typo), /Did you mean:\n {2}src\/b\.ts/);
  assert.match(lookupFailureMessage(lookupNode(g, 'nothing-like-it.rs')), /not in the graph/);
});

test('symbol: an unknown name says what is not tracked and offers near misses', async () => {
  const g = await buildGraph({ root: chain(), noGit: true });
  const r = symbolReport(g, 'bb');
  assert.deepEqual(r.importedBy, []);
  assert.match(r.note ?? '', /local function, a method/);
  assert.equal(r.similar, undefined, 'every 1-letter export is 2 edits from "bb": no suggestion beats a wrong one');
  assert.equal(symbolReport(g, 'b').note, undefined);

  const root = project({ 'src/build.ts': 'export function buildGraph() {}\n', 'src/use.ts': "import { buildGraph } from './build';\n" });
  assert.deepEqual(symbolReport(await buildGraph({ root, noGit: true }), 'buildGraf').similar, ['buildGraph']);
  assert.equal(editDistance('abc', 'xyzxyz', 2), 3, 'gives up past the limit');
});

test('shopify: editor-placeable sections and blocks are not orphans; locales are not hubs', async () => {
  const preset = (name: string) => `{% schema %}\n${JSON.stringify({ name, presets: [{ name }] })}\n{% endschema %}\n`;
  const root = project({
    'config/settings_schema.json': '[]',
    'layout/theme.liquid': "{{ 'x' | t }}{% render 'card' %}",
    'templates/index.json': '{"sections":{}}',
    'locales/en.default.json': '{"x":"y"}',
    'snippets/card.liquid': "{{ 'x' | t }}",
    'sections/hero.liquid': preset('Hero'),
    'sections/old.liquid': '{% schema %}{"name":"Old"}{% endschema %}',
    'blocks/badge.liquid': preset('Badge'),
    'blocks/_private.liquid': 'x',
    'blocks/_private-preset.liquid': preset('Private'),
    'assets/types.d.ts': 'declare const x: number;',
  });
  const g = await buildGraph({ root, noGit: true });
  assert.deepEqual(g.nodes.filter(n => n.orphan && fileKind(n.id) === 'code').map(n => n.id),
    ['blocks/_private-preset.liquid', 'blocks/_private.liquid', 'sections/old.liquid'], 'a private block is placed only by a file naming it');
  assert.deepEqual(overview(g).entrypoints.slice(0, 2), ['layout/theme.liquid', 'templates/index.json'], 'pages before placeable sections');
  assert.equal(fileKind('assets/types.d.ts'), 'config', 'ambient declarations are loaded by config, not imported');
  const o = overview(g);
  assert.ok(!o.hubs.some(([f]) => f.startsWith('locales/')), JSON.stringify(o.hubs));
  assert.ok(!o.entrypoints.some(f => f.startsWith('locales/') || f.startsWith('config/')), JSON.stringify(o.entrypoints));
  assert.deepEqual(o.hubs[0], ['snippets/card.liquid', 1]);
});

const rpc = async (method: string, params?: unknown) =>
  (await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), path.join(tmpdir(), 'none', 'graph.json')) as any).result;

test('mcp: negotiates the revision, sends instructions, marks every tool read-only', async () => {
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).protocolVersion, '2025-06-18');
  const unknown = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(unknown.protocolVersion, '2025-11-25');
  assert.ok(unknown.instructions.startsWith(INSTRUCTIONS));
  assert.match(unknown.instructions, /never re-scans/, 'handleLine without opts: autoscan is off, and the text says so');
  assert.match(instructionsFor(true), /re-scanned automatically/);
  assert.ok(instructionsFor(true).length < 4096, 'Claude Code keeps the first 4096 characters');
  const { tools } = await rpc('tools/list');
  assert.equal(tools.length, TOOLS.length);
  for (const t of tools) {
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
  }
  assert.equal(tools.find((t: any) => t.name === 'nervegraph_query')._meta['anthropic/alwaysLoad'], true);
});

test('mcp: a failed lookup returns the suggestions, in-band', async () => {
  const root = chain();
  const g = await buildGraph({ root, noGit: true });
  await writeGraphAtomic(path.join(root, '.nervegraph'), g);
  const reply = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nervegraph_query', arguments: { file: 'src' } } }),
    path.join(root, '.nervegraph', 'graph.json')) as any;
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /directory of 3 files/);
});

// --- regressions from review: autoscan must re-scan the same thing, in the same place ---

const ago = (root: string, files: string[], ms = 3_600_000) => {
  const t = new Date(Date.now() - ms);
  for (const f of ['', ...files]) utimesSync(path.join(root, f), t, t);
};

test('autoscan keeps the scan flags: --ignore stays ignored, --pretty stays pretty', () => {
  const root = chain();
  writeFileSync(path.join(root, 'gen.ts'), "import { a } from './src/a';\n");
  assert.equal(cli(['scan', '--ignore', 'gen.ts', '--pretty', '--quiet', '--no-git'], root).code, 0);
  ago(root, ['src', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'test', 'test/c.test.ts', 'package.json', 'gen.ts']);
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n');
  const r = cli(['query', 'src/a.ts', '--json'], root);
  assert.match(r.err, /re-scanning/);
  assert.deepEqual(JSON.parse(r.out).usedBy.map((u: any) => u.file), ['src/b.ts'], 'gen.ts is still ignored');
  const text = readFileSync(path.join(root, '.nervegraph', 'graph.json'), 'utf8');
  assert.ok(text.includes('\n  "'), 'still indented');
  assert.deepEqual(JSON.parse(text).scan, { ignore: ['gen.ts'], noGit: true, pretty: true });
});

test('a committed graph copied to a second checkout belongs to that checkout', async () => {
  const first = chain();
  const g = await buildGraph({ root: first, noGit: true });
  const second = chain();
  await writeGraphAtomic(path.join(second, '.nervegraph'), g);
  writeFileSync(path.join(second, 'src', 'd.ts'), "import { a } from './a';\n");
  const r = cli(['query', 'src/a.ts', '--json'], second);
  assert.equal(r.code, 0, r.err);
  assert.ok(JSON.parse(r.out).usedBy.some((u: any) => u.file === 'src/d.ts'), 'the edit in this checkout is seen');
  const written = JSON.parse(readFileSync(path.join(second, '.nervegraph', 'graph.json'), 'utf8'));
  assert.equal(path.resolve(written.root), path.resolve(second));
});

test('outside a repository: the graph above is used from a subfolder; with none, nothing is scanned unasked', () => {
  const root = chain(); // no .git anywhere (the system temp folder is not a repository)
  assert.equal(cli(['scan', '--quiet', '--no-git'], root).code, 0);
  const fromSub = cli(['query', 'a.ts', '--json'], path.join(root, 'src'));
  assert.equal(fromSub.code, 0, fromSub.err);
  assert.deepEqual(JSON.parse(fromSub.out).usedBy.map((u: any) => u.file), ['src/b.ts']);
  assert.ok(!existsSync(path.join(root, 'src', '.nervegraph')), 'no second graph of the subfolder');

  const bare = project({ 'x.ts': '' });
  const r = cli(['query', 'x.ts', '--json'], bare);
  assert.equal(r.code, 5, 'the old "run nerve scan" answer');
  assert.match(r.err, /run: nerve scan/);
  assert.ok(!existsSync(path.join(bare, '.nervegraph')));
});

test('overview of a graph under another name reports staleness instead of claiming fresh', async () => {
  const root = chain();
  const g = await buildGraph({ root, noGit: true });
  const custom = path.join(root, 'custom.json');
  writeFileSync(custom, JSON.stringify({ ...g, scannedAt: new Date(Date.now() - 60_000).toISOString() }));
  ago(root, ['src', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'test', 'test/c.test.ts', 'package.json']);
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 3;\n');
  const o = JSON.parse(cli(['overview', '--json', '--graph', custom], root).out);
  assert.equal(o.stale, 1);
});

test('staleness: after a walk that found nothing, an unrelated write in the root does not cost a walk per call', async () => {
  const root = chain();
  const g = await buildGraph({ root, noGit: true });
  const graphPath = path.join(root, '.nervegraph', 'graph.json');
  await writeGraphAtomic(path.dirname(graphPath), g);
  g.scannedAt = new Date(Date.now() - 60_000).toISOString();
  ago(root, ['src', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'test', 'test/c.test.ts', 'package.json']);
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true }); // touches the root, adds nothing scanned
  assert.deepEqual(staleFiles(g, graphPath), []);
  assert.ok(existsSync(path.join(root, '.nervegraph', 'walked')), 'the empty walk is recorded');
  await new Promise(r => setTimeout(r, 20));
  writeFileSync(path.join(root, 'src', 'later.ts'), '');
  assert.deepEqual(staleFiles(g, graphPath), ['src/later.ts'], 'a change after the recorded walk still counts');
});

test('staleness: a future timestamp is not a change; a new file still is, without a walk when nothing moved', async () => {
  const root = chain();
  const g = await buildGraph({ root, noGit: true });
  const graphPath = path.join(root, '.nervegraph', 'graph.json');
  await writeGraphAtomic(path.dirname(graphPath), g);
  g.scannedAt = new Date(Date.now() - 60_000).toISOString();
  ago(root, ['src', 'src/a.ts', 'src/b.ts', 'src/c.ts', 'test', 'test/c.test.ts', 'package.json']);
  assert.deepEqual(staleFiles(g, graphPath), []);
  const future = new Date(Date.now() + 365 * 86_400_000);
  utimesSync(path.join(root, 'src', 'a.ts'), future, future);
  assert.deepEqual(staleFiles(g, graphPath), [], 'a date in 2027 proves nothing');
  writeFileSync(path.join(root, 'src', 'new.ts'), '');
  assert.deepEqual(staleFiles(g, graphPath), ['src/new.ts']);
});

test('lookup: near misses in the typed directory come first', async () => {
  const root = project({ 'package.json': '{}', 'a/util.ts': '', 'b/util.ts': '', 'z/utils.ts': '' });
  const g = await buildGraph({ root, noGit: true });
  assert.deepEqual(lookupNode(g, 'z/utill.ts').suggestions?.files[0], 'z/utils.ts');
});
