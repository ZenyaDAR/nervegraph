import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAliases, expandAlias, parseJsonc } from '../src/scan/aliases.ts';
import { resolveRefs } from '../src/graph/resolve.ts';
import { detectProfile } from '../src/scan/profile.ts';
import type { RawRef } from '../src/graph/types.ts';

function tmpProject(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nervegraph-alias-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

test('parseJsonc survives comments and trailing commas without eating URLs', () => {
  const cfg = parseJsonc(`{
    // a line comment
    "compilerOptions": { /* block */ "baseUrl": ".", "homepage": "https://x.dev" },
  }`);
  assert.equal(cfg.compilerOptions.baseUrl, '.');
  assert.equal(cfg.compilerOptions.homepage, 'https://x.dev');
});

test('tsconfig paths become alias rules', () => {
  const root = tmpProject({
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["src/*"] } } }',
  });
  const rules = loadAliases(root);
  assert.deepEqual(expandAlias('@/components/Button', rules)[0], 'src/components/Button');
});

test('baseUrl alone resolves bare specifiers, but a paths entry wins', () => {
  const root = tmpProject({
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": "src", "paths": { "~/*": ["lib/*"] } } }',
  });
  const rules = loadAliases(root);
  // The paths entry is tried first; the baseUrl catch-all is only a fallback.
  assert.deepEqual(expandAlias('~/util', rules), ['src/lib/util', 'src/~/util']);
  assert.deepEqual(expandAlias('models/user', rules), ['src/models/user']);
});

test('package.json imports and workspace names resolve to project files', () => {
  const root = tmpProject({
    'package.json': JSON.stringify({
      imports: { '#lib/*': './src/lib/*.js' },
      workspaces: ['packages/*'],
    }),
    'packages/ui/package.json': JSON.stringify({ name: '@app/ui' }),
  });
  const rules = loadAliases(root);
  assert.deepEqual(expandAlias('#lib/money', rules), ['src/lib/money.js']);
  assert.deepEqual(expandAlias('@app/ui', rules), ['packages/ui']);
  assert.deepEqual(expandAlias('@app/ui/button', rules), ['packages/ui/button']);
});

test('an aliased import becomes a real edge, an unknown package stays external', () => {
  const aliases = [{ prefix: '@/*', targets: ['src/*'] }];
  const existing = new Set(['src/components/Button.tsx']);
  const refs: RawRef[] = [
    { rel: 'import', target: '@/components/Button', line: 1, raw: '', literal: true },
    { rel: 'import', target: 'react', line: 2, raw: '', literal: true },
  ];
  const out = resolveRefs('src/app.tsx', refs, {
    profile: 'js',
    fileExists: (id) => existing.has(id),
    aliases,
  });
  assert.deepEqual(out.edges.map(e => e.to), ['src/components/Button.tsx']);
  assert.equal(out.unresolved.length, 1);
  assert.equal(out.unresolved[0].reason, 'external');
});

test('a workspace package resolves through its directory index', () => {
  const existing = new Set(['packages/ui/src/index.ts']);
  const refs: RawRef[] = [{ rel: 'import', target: '@app/ui/src', line: 1, raw: '', literal: true }];
  const out = resolveRefs('apps/web/main.ts', refs, {
    profile: 'js',
    fileExists: (id) => existing.has(id),
    aliases: [{ prefix: '@app/ui', targets: ['packages/ui'] }],
  });
  assert.equal(out.edges[0].to, 'packages/ui/src/index.ts');
});

test('a non-JS repo gets the poly profile instead of a bogus js warning', () => {
  const rust = tmpProject({ 'Cargo.toml': '[package]\nname = "x"\n' });
  assert.deepEqual(detectProfile(rust), { profile: 'poly' });

  const empty = tmpProject({ 'README.md': '# x' });
  assert.equal(detectProfile(empty).profile, 'poly');
  assert.ok(detectProfile(empty).warning);

  const js = tmpProject({ 'package.json': '{}' });
  assert.equal(detectProfile(js).profile, 'js');
});
