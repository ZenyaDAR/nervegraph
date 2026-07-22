import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanJavaScript } from '../../src/scan/scanners/javascript.ts';

test('ESM import / export-from / dynamic import', () => {
  const { refs } = scanJavaScript({
    id: 'x.js',
    content: `import a from './a.js';\nexport { b } from './b.js';\nimport('./c.js');\n`,
  });
  assert.deepEqual(refs.map(r => [r.rel, r.target]), [
    ['import', './a.js'],
    ['import', './b.js'],
    ['dynamic_import', './c.js'],
  ]);
});

test('require literal', () => {
  const { refs } = scanJavaScript({ id: 'x.js', content: `const u = require('./utils');` });
  assert.deepEqual(refs.map(r => [r.rel, r.target]), [['require', './utils']]);
});

test('import in a string or comment produces no edge', () => {
  const { refs } = scanJavaScript({ id: 'x.js', content: `const s = "import x from './fake.js'"; // import y from './fake2.js'` });
  assert.equal(refs.length, 0);
});

test('bare import is left for the resolver to mark external', () => {
  const { refs } = scanJavaScript({ id: 'x.js', content: `import _ from 'lodash';` });
  assert.deepEqual(refs.map(r => [r.rel, r.target]), [['import', 'lodash']]);
});

test('exports are collected', () => {
  const { exports } = scanJavaScript({ id: 'x.js', content: `export function formatMoney() {}\nexport const x = 1;` });
  assert.deepEqual(exports, ['formatMoney', 'x']);
});
