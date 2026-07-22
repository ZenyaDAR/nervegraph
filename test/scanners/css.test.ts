import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanCss } from '../../src/scan/scanners/css.ts';

test('@import in three forms', () => {
  const { refs } = scanCss({
    id: 'x.css',
    content: `@import "a.css";\n@import url("b.css");\n@use "mixins";\n`,
  });
  assert.deepEqual(refs.map(r => [r.rel, r.target]), [
    ['css_import', 'a.css'],
    ['css_import', 'b.css'],
    ['css_import', 'mixins'],
  ]);
});

test('url() relative / data / external', () => {
  const { refs } = scanCss({
    id: 'x.css',
    content: `.a { background: url(../images/bg.png); }\n.b { background: url(data:image/png;base64,abc); }\n.c { background: url("https://fonts.example.com/f.woff"); }\n`,
  });
  assert.equal(refs.length, 2);
  assert.equal(refs[0].target, '../images/bg.png');
  assert.equal(refs[1].value, 'external');
});

test('extracts classes from a compound selector', () => {
  const { classes } = scanCss({ id: 'x.css', content: `.product-card.is-active > .price { color: red; }` });
  assert.deepEqual(new Set(classes), new Set(['product-card', 'is-active', 'price']));
});
