import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLanguage } from '../src/scan/languages/index.ts';
import { findResolver } from '../src/graph/resolvers/index.ts';
import { REL_TYPES } from '../src/graph/types.ts';

test('language registry dispatches by file id and profile', () => {
  assert.equal(findLanguage('snippets/x.liquid', { profile: 'shopify' })?.id, 'liquid');
  assert.equal(findLanguage('assets/x.js', { profile: 'shopify' })?.id, 'javascript');
  assert.equal(findLanguage('assets/x.scss', { profile: 'js' })?.id, 'css');
  assert.equal(findLanguage('templates/product.json', { profile: 'shopify' })?.id, 'shopify-json');
  assert.equal(findLanguage('config/settings_schema.json', { profile: 'shopify' }), undefined);
  assert.equal(findLanguage('templates/product.json', { profile: 'js' }), undefined);
});

test('resolver registry is keyed by (rel, profile), not language', () => {
  assert.ok(findResolver('render', 'shopify'));
  assert.equal(findResolver('render', 'js'), undefined);
  assert.ok(findResolver('import', 'shopify'));
  assert.ok(findResolver('import', 'js'));
  assert.ok(findResolver('asset', 'shopify'));
  assert.ok(findResolver('asset', 'js'));
  // asset_url is the Shopify naming convention, so it has no js counterpart.
  assert.ok(findResolver('asset_url', 'shopify'));
  assert.equal(findResolver('asset_url', 'js'), undefined);
});

test('every RelType a scanner can emit has a resolver in at least one profile', () => {
  // Guards the registry seam: a new scanner rel that nobody registered would
  // silently resolve to "external" for every reference it produces.
  // class_usage is derived in the viewer from node class lists, and
  // custom_element is resolved by name in build.ts against the project-wide
  // customElements.define() index — neither goes through a path resolver.
  const rels = REL_TYPES.filter(r => r !== 'class_usage' && r !== 'custom_element');
  for (const rel of rels) {
    assert.ok(
      findResolver(rel, 'shopify') || findResolver(rel, 'js'),
      `no resolver registered for rel "${rel}"`,
    );
  }
});

test('language registry claims every language nervegraph advertises', () => {
  const expected: [string, string][] = [
    ['a.liquid', 'liquid'],
    ['a.js', 'javascript'], ['a.mjs', 'javascript'], ['a.cjs', 'javascript'], ['a.jsx', 'javascript'],
    ['a.ts', 'javascript'], ['a.tsx', 'javascript'], ['a.mts', 'javascript'],
    ['a.html', 'html'], ['a.htm', 'html'],
    ['a.css', 'css'], ['a.scss', 'css'], ['a.sass', 'css'], ['a.less', 'css'],
    ['a.py', 'python'], ['a.pyi', 'python'],
    ['a.rb', 'ruby'], ['a.rake', 'ruby'], ['a.gemspec', 'ruby'],
    ['a.rs', 'rust'],
    ['a.vue', 'component'], ['a.svelte', 'component'], ['a.astro', 'component'],
    ['a.go', 'go'],
    ['a.php', 'php'], ['a.phtml', 'php'],
    ['a.java', 'jvm'], ['a.kt', 'jvm'], ['a.kts', 'jvm'],
    ['a.c', 'clang'], ['a.h', 'clang'], ['a.cpp', 'clang'], ['a.hpp', 'clang'],
    ['a.md', 'markdown'], ['a.mdx', 'markdown'],
    ['a.sh', 'shell'],
    ['a.tf', 'terraform'],
  ];
  for (const [file, langId] of expected) {
    assert.equal(findLanguage(file, { profile: 'js' })?.id, langId, `${file} should be claimed by ${langId}`);
  }
});
