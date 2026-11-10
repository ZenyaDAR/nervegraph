import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleLine, TOOLS } from '../src/commands/mcp.ts';
import { fileKind, isTestFile, riskFor, packageEntrypoints } from '../src/graph/analysis.ts';
import type { GraphNode } from '../src/graph/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', 'src', 'cli.ts');
const FIXTURE = path.join(HERE, 'fixtures', 'agent-features');

function cli(args: string[], cwd?: string) {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', CLI, ...args], {
    encoding: 'utf8', timeout: 30_000, cwd,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Not fs.cpSync: its native implementation aborts the process on Windows
// when the path holds non-ASCII characters (Node 22).
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), dst = path.join(to, e.name);
    if (e.isDirectory()) copyDir(src, dst); else writeFileSync(dst, readFileSync(src));
  }
}

/** A fresh copy of the fixture, scanned into `<copy>/.nervegraph/graph.json`. */
function scanned() {
  const dir = mkdtempSync(path.join(tmpdir(), 'nervegraph-agent-'));
  copyDir(FIXTURE, dir);
  const r = cli(['scan', dir, '--out', path.join(dir, '.nervegraph'), '--quiet', '--no-git']);
  assert.equal(r.code, 0, r.err);
  return { dir, graphPath: path.join(dir, '.nervegraph', 'graph.json') };
}

const json = (r: { code: number | null; out: string; err: string }) => {
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out);
};

const node = (id: string, extra: Partial<GraphNode> = {}) => ({
  id, type: 'javascript', lang: 'javascript', size: 1, loc: 1, hash: 'h',
  in: 0, out: 0, risk: 'low', orphan: false, entrypoint: false, ...extra,
}) as GraphNode;

// --- file kinds and risk ---------------------------------------------------------

test('test files are told apart from fixtures, docs and config', () => {
  for (const id of ['test/a.ts', 'src/a.test.ts', 'src/__tests__/a.js', 'b.spec.tsx', 'pkg/test_x.py', 'x_test.go', 'spec/a_spec.rb']) {
    assert.ok(isTestFile(id), id);
  }
  for (const id of ['src/a.ts', 'test/fixtures/a.ts', 'latest.ts', 'contest/a.ts']) assert.ok(!isTestFile(id), id);
  assert.equal(fileKind('test/fixtures/a.ts'), 'fixture');
  assert.equal(fileKind('README.md'), 'doc');
  assert.equal(fileKind('docs/guide.html'), 'doc');
  assert.equal(fileKind('tsconfig.json'), 'config');
  assert.equal(fileKind('vite.config.ts'), 'config');
  assert.equal(fileKind('scripts/release.mjs'), 'entry');
  assert.equal(fileKind('media/logo.png'), 'asset');
  assert.equal(fileKind('src/lib/x.ts'), 'code');
});

test('risk: leaf entrypoints, locales and docs are not high', () => {
  assert.equal(riskFor(node('src/cli.ts', { entrypoint: true }), false), 'low');
  assert.equal(riskFor(node('src/cli.ts', { entrypoint: true, out: 4 }), false), 'medium');
  assert.equal(riskFor(node('locales/fr.json', { type: 'json', entrypoint: true }), false), 'low');
  assert.equal(riskFor(node('README.md', { type: 'markdown', in: 30 }), true), 'low');
  assert.equal(riskFor(node('src/types.ts', { in: 10 }), false), 'high');
  assert.equal(riskFor(node('src/util.ts', { in: 3 }), true), 'high');
  assert.equal(riskFor(node('src/util.ts', { in: 1 }), false), 'low');
});

test('package.json bin under tsconfig outDir maps back to the source file', () => {
  const ids = packageEntrypoints(FIXTURE);
  assert.ok(ids.has('dist/cli.js'));
  assert.ok(ids.has('src/cli.ts'));
});

// --- scan --------------------------------------------------------------------------

test('scan: the package bin is an entrypoint, not an orphan, and not high risk', () => {
  const { graphPath } = scanned();
  const graph = JSON.parse(readFileSync(graphPath, 'utf8'));
  const cli = graph.nodes.find((n: any) => n.id === 'src/cli.ts');
  assert.equal(cli.entrypoint, true);
  assert.equal(cli.orphan, false);
  assert.notEqual(cli.risk, 'high');
  assert.equal(graph.nodes.find((n: any) => n.id === 'README.md').risk, 'low');
  assert.equal(graph.stats.orphans, graph.nodes.filter((n: any) => n.orphan).length);
});

test('scan --json splits external references from unresolved ones', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'nervegraph-agent-'));
  const r = json(cli(['scan', FIXTURE, '--out', dir, '--json', '--no-git']));
  assert.equal(r.unresolved.external, 1, 'node:fs');
  assert.equal(r.unresolved.unresolved, 0);
});

test('scan keeps the previous graph, and diff with no arguments compares the two', () => {
  const { dir } = scanned();
  writeFileSync(path.join(dir, 'src', 'lib', 'extra.ts'), "import { dead } from './dead';\nexport const extra = dead;\n");
  assert.equal(cli(['scan', '.', '--quiet', '--no-git'], dir).code, 0);
  assert.ok(existsSync(path.join(dir, '.nervegraph', 'graph.prev.json')));
  const diff = json(cli(['diff', '--json'], dir));
  assert.deepEqual(diff.files.added, ['src/lib/extra.ts']);
  assert.deepEqual(diff.adopted, ['src/lib/dead.ts']);
});

// --- query -------------------------------------------------------------------------

test('query --json: compact, grouped per file, with the tests that reach it', () => {
  const { graphPath } = scanned();
  const r = cli(['query', 'helper.ts', '--json', '--graph', graphPath]);
  assert.equal(r.out.trim().split('\n').length, 1, 'minified: one line');
  const card = json(r);
  assert.deepEqual(card.usedBy.map((u: any) => u.file), ['src/cli.ts', 'src/lib/other.ts', 'test/helper.spec.ts']);
  assert.deepEqual(card.usedBy[0], { file: 'src/cli.ts', rel: 'import', lines: [2], names: ['helper'] });
  assert.ok(!('raw' in card.usedBy[0]), 'raw only on request');
  assert.deepEqual(card.tests, ['test/helper.spec.ts']);

  const raw = json(cli(['query', 'helper.ts', '--json', '--raw', '--graph', graphPath]));
  assert.match(raw.usedBy[0].raw[0], /import \{ helper \}/);

  const capped = json(cli(['query', 'helper.ts', '--json', '--limit', '1', '--graph', graphPath]));
  assert.equal(capped.usedBy.length, 1);
  assert.equal(capped.truncated.usedBy, 2);

  const pretty = cli(['query', 'helper.ts', '--json', '--pretty', '--graph', graphPath]);
  assert.ok(pretty.out.split('\n').length > 10);
});

test('query --depth follows --direction; --transitive lists dependents', () => {
  const { graphPath } = scanned();
  const out = json(cli(['query', 'src/lib/other.ts', '--json', '--depth', '2', '--direction', 'out', '--graph', graphPath]));
  assert.deepEqual(out.neighbors, ['src/lib/helper.ts']);
  const inn = json(cli(['query', 'src/lib/other.ts', '--json', '--depth', '2', '--direction', 'in', '--graph', graphPath]));
  assert.deepEqual(inn.neighbors, ['src/cli.ts']);
  const t = json(cli(['query', 'helper.ts', '--json', '--transitive', '--graph', graphPath]));
  assert.deepEqual(t.dependents, ['src/cli.ts', 'src/lib/other.ts', 'test/helper.spec.ts']);
  assert.equal(cli(['query', 'helper.ts', '--direction', 'up', '--graph', graphPath]).code, 2);
});

test('query --symbol: where it is exported and every import site', () => {
  const { graphPath } = scanned();
  const r = json(cli(['query', '--symbol', 'helper', '--json', '--graph', graphPath]));
  assert.deepEqual(r.exportedBy, ['src/lib/helper.ts']);
  assert.deepEqual(r.importedBy.map((s: any) => `${s.file}:${s.line}`), ['src/cli.ts:2', 'src/lib/other.ts:1', 'test/helper.spec.ts:1']);
  const none = json(cli(['query', '--symbol', 'help', '--json', '--graph', graphPath]));
  assert.deepEqual(none.exportedBy, []);
  assert.ok(none.similar.includes('helper'));
});

test('query --orphans: code only by default, every kind with --all', () => {
  const { graphPath } = scanned();
  const code = json(cli(['query', '--orphans', '--json', '--graph', graphPath]));
  assert.deepEqual(code.files.map((f: any) => f.file), ['src/lib/dead.ts']);
  assert.equal(code.byKind.fixture, 1);
  assert.equal(code.byKind.test, 1);
  const all = json(cli(['query', '--orphans', '--all', '--json', '--fields', 'file,kind', '--graph', graphPath]));
  assert.deepEqual(all.files.find((f: any) => f.file === 'test/fixtures/sample.ts'), { file: 'test/fixtures/sample.ts', kind: 'fixture' });
  assert.ok(!all.files.some((f: any) => f.file === 'src/cli.ts'), 'the bin is an entrypoint');
});

test('query --changed: git changes, their dependents and the tests to run', (t) => {
  if (spawnSync('git', ['--version']).status !== 0) return t.skip('git not installed');
  const { dir, graphPath } = scanned();
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  writeFileSync(path.join(dir, '.gitignore'), '.nervegraph/\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  writeFileSync(path.join(dir, 'src', 'lib', 'helper.ts'), 'export function helper() {\n  return 1;\n}\n');

  const r = json(cli(['query', '--changed', '--json', '--graph', graphPath]));
  assert.deepEqual(r.changed, ['src/lib/helper.ts']);
  assert.deepEqual(r.directDependents, ['src/cli.ts', 'src/lib/other.ts', 'test/helper.spec.ts']);
  assert.deepEqual(r.tests, ['test/helper.spec.ts']);

  git('commit', '-q', '-am', 'edit');
  const clean = json(cli(['query', '--changed', '--json', '--graph', graphPath]));
  assert.equal(clean.counts.changed, 0);
  const vsBase = json(cli(['query', '--changed', '--base', 'HEAD~1', '--json', '--graph', graphPath]));
  assert.deepEqual(vsBase.changed, ['src/lib/helper.ts']);
  // A ref that looks like an option is refused, never handed to git.
  assert.equal(cli(['query', '--changed', '--base=--output=x', '--graph', graphPath]).code, 1);
  assert.ok(!existsSync(path.join(dir, 'x')));
});

// --- overview and agents-md -----------------------------------------------------------

test('overview: one small answer about the layout', () => {
  const { graphPath } = scanned();
  const r = cli(['overview', '--json', '--graph', graphPath]);
  assert.ok(Buffer.byteLength(r.out) < 1500, `${Buffer.byteLength(r.out)} bytes`);
  const o = json(r);
  assert.deepEqual(o.entrypoints, ['src/cli.ts']);
  assert.deepEqual(o.hubs[0], ['src/lib/helper.ts', 3]);
  assert.equal(o.issues.external, 1);
  assert.equal(o.issues.unresolved, 0);
  assert.equal(o.issues.orphans.code, 1);
  assert.equal(o.stale, 0);
  assert.ok(o.next.length >= 2);
  assert.match(cli(['overview', '--graph', graphPath]).out, /hubs\s+src\/lib\/helper\.ts/);
});

test('agents-md: a short snippet that warns against reading graph.json whole', () => {
  const { graphPath } = scanned();
  const r = cli(['agents-md', '--graph', graphPath]);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.ok(lines.length >= 10 && lines.length <= 16, `${lines.length} lines`);
  assert.match(r.out, /Do not `cat`/);
  assert.match(r.out, /`src\/cli\.ts`/);
  assert.match(r.out, /`src\/lib\/helper\.ts` \(3\)/);
});

// --- MCP ---------------------------------------------------------------------------------

async function mcpCall(graphPath: string, name: string, args: unknown = {}, opts = {}) {
  const reply = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), graphPath, opts) as any;
  return reply.result;
}

test('mcp: a small tool list, each answering in one compact line', async () => {
  assert.deepEqual(TOOLS.map(t => t.name), ['nervegraph_overview', 'nervegraph_query', 'nervegraph_symbol', 'nervegraph_changed', 'nervegraph_list']);
  const { graphPath } = scanned();

  const overview = await mcpCall(graphPath, 'nervegraph_overview');
  assert.ok(!overview.content[0].text.includes('\n'));
  assert.deepEqual(JSON.parse(overview.content[0].text).entrypoints, ['src/cli.ts']);

  const card = JSON.parse((await mcpCall(graphPath, 'nervegraph_query', { file: 'other.ts', depth: 1, direction: 'out' })).content[0].text);
  assert.deepEqual(card.neighbors, ['src/lib/helper.ts']);

  const symbol = JSON.parse((await mcpCall(graphPath, 'nervegraph_symbol', { name: 'other' })).content[0].text);
  assert.deepEqual(symbol.importedBy, [{ file: 'src/cli.ts', line: 3, from: 'src/lib/other.ts' }]);

  const unresolved = JSON.parse((await mcpCall(graphPath, 'nervegraph_list', { kind: 'unresolved' })).content[0].text);
  assert.equal(unresolved.external, 1);
  const packages = JSON.parse((await mcpCall(graphPath, 'nervegraph_list', { kind: 'packages' })).content[0].text);
  assert.equal(packages.packages[0].id, '(root)');
  const limited = JSON.parse((await mcpCall(graphPath, 'nervegraph_list', { kind: 'orphans', all: true, limit: 1 })).content[0].text);
  assert.equal(limited.files.length, 1);
  assert.ok(limited.truncated.files > 0);

  assert.equal((await mcpCall(graphPath, 'nervegraph_query', { file: 'helper.ts', limit: -1 })).isError, true);
  assert.equal((await mcpCall(graphPath, 'nervegraph_symbol', {})).isError, true);
});

test('mcp: a missing or stale graph is re-scanned unless autoscan is off', async () => {
  const { dir, graphPath } = scanned();
  rmSync(graphPath);
  const off = await mcpCall(graphPath, 'nervegraph_overview', {}, { autoscan: false });
  assert.equal(off.isError, true);
  const on = await mcpCall(graphPath, 'nervegraph_overview', {}, { autoscan: true });
  assert.equal(on.isError, undefined, on.content[0].text);
  assert.ok(existsSync(graphPath));

  // A file edited after the scan makes the graph stale: the next call re-scans.
  await new Promise(r => setTimeout(r, 20));
  writeFileSync(path.join(dir, 'src', 'lib', 'dead.ts'), "import { helper } from './helper';\nexport const dead = helper();\n");
  const before = JSON.parse(readFileSync(graphPath, 'utf8')).scannedAt;
  const card = JSON.parse((await mcpCall(graphPath, 'nervegraph_query', { file: 'helper.ts' }, { autoscan: true })).content[0].text);
  assert.ok(card.usedBy.some((u: any) => u.file === 'src/lib/dead.ts'));
  assert.notEqual(JSON.parse(readFileSync(graphPath, 'utf8')).scannedAt, before);
});
