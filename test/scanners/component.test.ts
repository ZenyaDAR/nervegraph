import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanComponent } from '../../src/scan/scanners/component.ts';

test('a .vue file yields its script imports, style imports and template assets', () => {
  const out = scanComponent({
    id: 'src/App.vue',
    content: `<template>
  <img src="./logo.png">
  <ChildCard />
</template>

<script setup lang="ts">
import ChildCard from './ChildCard.vue';
import { fmt } from '@/lib/format';
</script>

<style lang="scss">
@use "../styles/tokens";
.card { background: url("./bg.png"); }
</style>
`,
  });
  assert.deepEqual(
    out.refs.map(r => [r.rel, r.target, r.line]),
    [
      ['asset', './logo.png', 2],
      ['import', './ChildCard.vue', 7],
      ['import', '@/lib/format', 8],
      ['css_import', '../styles/tokens', 12],
      ['asset', './bg.png', 13],
    ],
  );
});

test('astro front matter is scanned as script', () => {
  const out = scanComponent({
    id: 'src/pages/index.astro',
    content: '---\nimport Layout from "../layouts/Base.astro";\n---\n<h1>hi</h1>\n',
  });
  assert.deepEqual(out.refs.map(r => [r.rel, r.target, r.line]), [['import', '../layouts/Base.astro', 2]]);
});

test('a <script src> is one edge, not a double one', () => {
  const out = scanComponent({
    id: 'src/Widget.svelte',
    content: '<script src="./widget.js"></script>\n<div class="widget"></div>\n',
  });
  assert.deepEqual(out.refs.map(r => r.rel), ['script_src']);
  assert.deepEqual(out.classes, ['widget']);
});
