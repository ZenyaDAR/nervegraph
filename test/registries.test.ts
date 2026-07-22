import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLanguage } from '../src/scan/languages/index.ts';
import { findResolver } from '../src/graph/resolvers/index.ts';

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
});
