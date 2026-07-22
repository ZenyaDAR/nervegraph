import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanHtml } from '../../src/scan/scanners/html.ts';

const refs = (content: string) => scanHtml({ id: 'index.html', content }).refs;
const pair = (content: string) => refs(content).map(r => [r.rel, r.target]);

test('script src and link href become script_src / link_href', () => {
  assert.deepEqual(
    pair(`<link rel="stylesheet" href="app.css"><script src="app.js"></script>`),
    [['link_href', 'app.css'], ['script_src', 'app.js']],
  );
});

test('media tags become asset refs', () => {
  assert.deepEqual(
    pair(`<img src="logo.png"><source src="clip.webm"><iframe src="frame.html"></iframe>`),
    [['asset', 'logo.png'], ['asset', 'clip.webm'], ['asset', 'frame.html']],
  );
});

test('unquoted and single-quoted attributes are read', () => {
  assert.deepEqual(pair(`<img src=logo.png><img src='a.png'>`), [['asset', 'logo.png'], ['asset', 'a.png']]);
});

test('absolute URLs, protocol-relative, data: and anchors are external, not missing files', () => {
  const r = refs(`
    <script src="https://cdn.example.com/x.js"></script>
    <script src="//cdn.example.com/y.js"></script>
    <img src="data:image/png;base64,AAAA">
    <link href="#top">
  `);
  assert.equal(r.length, 4);
  assert.ok(r.every(x => x.value === 'external' && x.literal === false));
});

test('commented-out markup produces no refs but does not shift line numbers', () => {
  const r = refs(`<!--\n<script src="ghost.js"></script>\n-->\n<script src="real.js"></script>`);
  assert.deepEqual(r.map(x => x.target), ['real.js']);
  assert.equal(r[0].line, 4);
});

test('a templating expression in the path is dynamic, not a literal', () => {
  const r = refs(`<img src="{{ product.image }}"><img src="\${path}">`);
  assert.equal(r.length, 2);
  assert.ok(r.every(x => x.literal === false && x.value === 'dynamic'));
});

test('class attributes are collected for the --classes cross-reference', () => {
  const out = scanHtml({ id: 'i.html', content: `<div class="card card--wide"><p class='lead'>` });
  assert.deepEqual(out.classes?.sort(), ['card', 'card--wide', 'lead']);
});

test('an empty or absent src yields no ref', () => {
  assert.deepEqual(refs(`<script></script><img src="">`), []);
});

test('root-absolute paths are kept verbatim for the resolver', () => {
  assert.deepEqual(pair(`<script src="/assets/app.js"></script>`), [['script_src', '/assets/app.js']]);
});
