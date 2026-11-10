import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanShopifyJson } from '../../src/scan/scanners/shopify-json.ts';

test('sections.*.type produces edges', () => {
  const { refs } = scanShopifyJson({
    id: 'templates/product.json',
    content: JSON.stringify({ sections: { main: { type: 'main-product' } } }),
  });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target, 'main-product');
  assert.equal(refs[0].rel, 'template_section');
});

test('blocks.*.type produces a theme-block candidate the resolver may drop', () => {
  const { refs } = scanShopifyJson({
    id: 'templates/product.json',
    content: JSON.stringify({ sections: { main: { type: 'main-product', blocks: { b1: { type: 'text' } } } } }),
  });
  assert.equal(refs.length, 2);
  assert.deepEqual([refs[1].rel, refs[1].target, refs[1].value], ['content_for', 'text', 'theme_block']);
});

test('invalid json throws so caller can record a warning', () => {
  assert.throws(() => scanShopifyJson({ id: 'x.json', content: '{ not json' }));
});

test('leading auto-generated /* */ comment is stripped before parsing', () => {
  const content = `/*\n * IMPORTANT: auto-generated, do not edit.\n */\n${JSON.stringify({ sections: { main: { type: 'main-product' } } })}`;
  const { refs } = scanShopifyJson({ id: 'templates/product.json', content });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].target, 'main-product');
});
