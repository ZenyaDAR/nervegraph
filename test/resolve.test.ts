import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRefs } from '../src/graph/resolve.ts';
import type { RawRef } from '../src/graph/types.ts';

function ctx(existing: string[]) {
  const set = new Set(existing.map(s => s.toLowerCase()));
  return { profile: 'shopify' as const, existingIds: new Set(existing), fileExists: (id: string) => set.has(id.toLowerCase()) };
}

test('shopify: render/section/asset resolve to conventional paths', () => {
  const refs: RawRef[] = [
    { rel: 'render', target: 'price', line: 1, raw: '', literal: true },
    { rel: 'section', target: 'header', line: 2, raw: '', literal: true },
    { rel: 'asset_url', target: 'cart.js', line: 3, raw: '', literal: true },
  ];
  const out = resolveRefs('sections/x.liquid', refs, ctx(['snippets/price.liquid', 'sections/header.liquid', 'assets/cart.js']));
  assert.deepEqual(out.edges.map(e => e.to), ['snippets/price.liquid', 'sections/header.liquid', 'assets/cart.js']);
  assert.equal(out.missingTargets.size, 0);
});

test('js: extension chain and /index fallback', () => {
  const refs: RawRef[] = [
    { rel: 'import', target: './utils', line: 1, raw: '', literal: true },
    { rel: 'import', target: './lib', line: 2, raw: '', literal: true },
  ];
  const c = { profile: 'js' as const, existingIds: new Set(['src/utils.ts', 'src/lib/index.js']), fileExists: (id: string) => new Set(['src/utils.ts', 'src/lib/index.js']).has(id) };
  const out = resolveRefs('src/main.ts', refs, c);
  assert.deepEqual(out.edges.map(e => e.to), ['src/utils.ts', 'src/lib/index.js']);
});

test('escaping project root is external, not a missing node', () => {
  const refs: RawRef[] = [{ rel: 'import', target: '../../outside', line: 1, raw: '', literal: true }];
  const c = ctx([]);
  const out = resolveRefs('src/main.ts', refs, { ...c, profile: 'js' });
  assert.equal(out.edges.length, 0);
  assert.equal(out.unresolved[0].reason, 'external');
});

test('bare import is external', () => {
  const refs: RawRef[] = [{ rel: 'import', target: 'lodash', line: 1, raw: '', literal: true }];
  const out = resolveRefs('src/main.ts', refs, { ...ctx([]), profile: 'js' });
  assert.equal(out.unresolved[0].reason, 'external');
});

test('missing target produces a missing-node edge, not unresolved', () => {
  const refs: RawRef[] = [{ rel: 'render', target: 'ghost', line: 1, raw: '', literal: true }];
  const out = resolveRefs('sections/x.liquid', refs, ctx([]));
  assert.equal(out.edges.length, 1);
  assert.equal(out.edges[0].to, 'snippets/ghost.liquid');
  assert.ok(out.missingTargets.has('snippets/ghost.liquid'));
});

test('css_import inside assets/ resolves relative to the file even without profile-js', () => {
  const refs: RawRef[] = [{ rel: 'css_import', target: 'base.css', line: 1, raw: '', literal: true }];
  const out = resolveRefs('assets/theme.css', refs, ctx(['assets/base.css']));
  assert.equal(out.edges[0].to, 'assets/base.css');
});

test('a missing .min asset falls back to the unminified source', () => {
  const refs: RawRef[] = [{ rel: 'asset_url', target: 'product-form.min.js', line: 1, raw: '', literal: true }];
  const out = resolveRefs('sections/x.liquid', refs, ctx(['assets/product-form.js']));
  assert.equal(out.edges[0].to, 'assets/product-form.js');
  assert.equal(out.missingTargets.size, 0);
});

test('a missing .min asset with no unminified source is still reported missing', () => {
  const refs: RawRef[] = [{ rel: 'asset_url', target: 'vendor.min.js', line: 1, raw: '', literal: true }];
  const out = resolveRefs('sections/x.liquid', refs, ctx([]));
  assert.equal(out.edges[0].to, 'assets/vendor.min.js');
  assert.ok(out.missingTargets.has('assets/vendor.min.js'));
});

test('scss @use finds the partial, the plain name, and the index file', () => {
  const c = (files: string[]) => ({ profile: 'js' as const, fileExists: (id: string) => files.includes(id) });
  const ref = (target: string): RawRef[] => [{ rel: 'css_import', target, line: 1, raw: '', literal: true }];

  assert.equal(resolveRefs('src/main.scss', ref('base'), c(['src/_base.scss'])).edges[0].to, 'src/_base.scss');
  assert.equal(resolveRefs('src/main.scss', ref('base'), c(['src/base.scss'])).edges[0].to, 'src/base.scss');
  assert.equal(resolveRefs('src/main.scss', ref('theme'), c(['src/theme/_index.scss'])).edges[0].to, 'src/theme/_index.scss');
  assert.equal(resolveRefs('src/main.css', ref('reset.css'), c(['src/reset.css'])).edges[0].to, 'src/reset.css');
});

test('static imports survive a file the JS lexer cannot parse', async () => {
  const { scanJavaScript } = await import('../src/scan/scanners/javascript.ts');
  // Generic arrow in .tsx — the shape that makes es-module-lexer throw.
  const out = scanJavaScript({
    id: 'a.tsx',
    content: "import Button from './Button';\nconst f = <T,>(x: T) => x;\n",
  });
  assert.deepEqual(out.refs.map(r => [r.rel, r.target]), [['import', './Button']]);
});
