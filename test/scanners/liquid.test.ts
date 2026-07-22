import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanLiquid } from '../../src/scan/scanners/liquid.ts';

function refs(content: string) {
  return scanLiquid({ id: 'x.liquid', content }).refs;
}

test('render forms: comma args, with, for, double quotes, multiline', () => {
  const r = refs(`{% render 'a', x: 1 %}
{% render "b" %}
{% render 'c' with foo %}
{% render 'd' for items as item %}
{% render
  'e' %}`);
  const targets = r.filter(x => x.rel === 'render').map(x => x.target);
  assert.deepEqual(targets, ['a', 'b', 'c', 'd', 'e']);
});

test('render inside comment produces no edge', () => {
  const r = refs(`{% comment %} {% render 'dead' %} {% endcomment %}`);
  assert.equal(r.length, 0);
});

test('render inside raw produces no edge', () => {
  const r = refs(`{% raw %} {% render 'not-real' %} {% endraw %}`);
  assert.equal(r.length, 0);
});

test('render with variable is unresolved/dynamic', () => {
  const r = refs(`{% render block.settings.snippet %}`);
  assert.equal(r.length, 1);
  assert.equal(r[0].literal, false);
  assert.equal(r[0].value, 'dynamic');
});

test('render with append is unresolved/concatenated', () => {
  const r = refs(`{% render 'icon-' | append: name %}`);
  assert.equal(r.length, 1);
  assert.equal(r[0].literal, false);
  assert.equal(r[0].value, 'concatenated');
});

test('asset_url and asset_img_url', () => {
  const r = refs(`{{ 'cart.js' | asset_url }} {{ 'logo.png' | asset_img_url: '100x' }}`);
  assert.deepEqual(r.map(x => [x.rel, x.target]), [['asset', 'cart.js'], ['asset', 'logo.png']]);
});

test('render inside {% liquid %} block', () => {
  const r = refs(`{% liquid
  assign x = 1
  render 'product-card'
%}`);
  assert.equal(r.length, 1);
  assert.equal(r[0].target, 'product-card');
});

test('line numbers survive a stripped multiline comment', () => {
  const r = refs(`line1
{% comment %}
multi
line
comment
{% endcomment %}
{% render 'after' %}`);
  assert.equal(r[0].line, 7);
});
