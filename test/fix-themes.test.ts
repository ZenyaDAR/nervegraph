import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildGraph } from '../src/graph/build.ts';
import { writeGraphAtomic } from '../src/graph/io.ts';
import { staleFiles } from '../src/commands/query.ts';
import { collectFiles, listFiles } from '../src/scan/files.ts';
import { expandAlias, loadAliases } from '../src/scan/aliases.ts';
import { importMapAliases } from '../src/scan/importmap.ts';
import { scanLiquid } from '../src/scan/scanners/liquid.ts';
import { scanCss } from '../src/scan/scanners/css.ts';
import { scanJavaScript } from '../src/scan/scanners/javascript.ts';
import { lineAt, sectionApiRefs } from '../src/scan/scanners/util.ts';
import type { Graph } from '../src/graph/types.ts';

// Regressions found by checking the graphs of five real Shopify themes
// (Horizon- and classic-style) against their sources.

function project(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nervegraph-themes-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const scan = (root: string) => buildGraph({ root, noGit: true });
/** Scan a theme; the settings schema is what makes it one. */
const theme = (files: Record<string, string>) => scan(project({ 'config/settings_schema.json': '[]', ...files }));
const edges = (g: Graph, from: string, to: string) => g.edges.filter(e => e.from === from && e.to === to);
const edge = (g: Graph, from: string, to: string) => edges(g, from, to)[0];
const node = (g: Graph, id: string) => g.nodes.find(n => n.id === id);
const missing = (g: Graph) => g.nodes.filter(n => n.missing).map(n => n.id);
const liquid = (content: string, id = 'sections/x.liquid') => scanLiquid({ id, content });
const schema = (s: unknown) => `{% schema %}\n${JSON.stringify(s, null, 2)}\n{% endschema %}\n`;
const page = (content: string, id = 'layout/theme.liquid') =>
  importMapAliases([{ id, absPath: id, content, size: content.length, mtime: 0 }]);

// ── 1. import maps and nested configs ───────────────────────────────────────

test('import map in liquid: bare imports become edges, CDN entries stay external', async () => {
  const g = await theme({
    'layout/theme.liquid': '{{ content_for_header }}',
    'snippets/scripts.liquid': [
      '<script type="importmap">',
      '{%- comment -%} "imports": { "old": "{{ \'gone.js\' | asset_url }}" } {%- endcomment -%}',
      '{ "imports": {',
      '  "@theme/component": "{{ \'component.js\' | asset_url }}",',
      '  "@shopify/events": "https://cdn.shopify.com/standard-events.js",',
      '  "vendor": "{{- "vendor.min.js" | asset_url -}}"',
      '} }',
      '</script>',
    ].join('\n'),
    'assets/component.js': 'export class Component {}\nexport class Unused {}\n',
    'assets/vendor.min.js': 'export const v=1',
    'assets/cart.js': "import { Component } from '@theme/component';\nimport { e } from '@shopify/events';\nimport { v } from 'vendor';\n",
  });
  assert.deepEqual(edge(g, 'assets/cart.js', 'assets/component.js')?.names, ['Component']);
  assert.ok(edge(g, 'assets/cart.js', 'assets/vendor.min.js'));
  const unresolved = g.unresolved.filter(u => u.from === 'assets/cart.js');
  assert.deepEqual(unresolved.map(u => [u.line, u.reason]), [[2, 'external']]);
  assert.deepEqual(missing(g), []);
});

test('import map parsing: prefixes, html paths, comments, and liquid relative URLs', () => {
  const map = (body: string) => `<script type="importmap">{ "imports": { ${body} } }</script>`;
  assert.deepEqual(page(map('"lib/": "./lib/", "app": "/src/app.js?v=1", "x": "../x.js", "out": "../../x.js"'), 'web/index.html'), [
    { prefix: 'lib/*', targets: ['web/lib/*'], scope: 'web' },
    { prefix: 'app', targets: ['src/app.js'], scope: 'web' },
    { prefix: 'x', targets: ['x.js'], scope: 'web' },
  ]);
  assert.deepEqual(page(map('"a": "./a.js"'), 'index.html'), [{ prefix: 'a', targets: ['a.js'] }]);
  assert.deepEqual(page(map('"a": "./a.js"')), [], 'relative to the page URL, not to the layout file');
  assert.deepEqual(page(`<!-- ${map('"a": "/a.js"')} -->`, 'index.html'), []);
  assert.deepEqual(page(`{% comment %}${map('"a": "/a.js"')}{% endcomment %}`), []);
  for (const before of ["{%- assign p = x | split: '<script>' -%}", '<script src="a.js"/>']) {
    assert.deepEqual(page(before + map('"a": "/a.js"')), [{ prefix: 'a', targets: ['a.js'] }], before);
  }
  assert.deepEqual(page('<script type="application/json">{ "importmap": "/a.js" }</script>'), []);
});

test("an HTML page's import map does not capture imports outside its directory", async () => {
  const g = await scan(project({
    'package.json': '{}',
    'examples/index.html': '<script type="importmap">{ "imports": { "lodash": "./stub.js" } }</script>',
    'examples/stub.js': '', 'examples/a.js': "import 'lodash';", 'server/index.js': "import 'lodash';",
  }));
  assert.ok(edge(g, 'examples/a.js', 'examples/stub.js'));
  assert.ok(!edge(g, 'server/index.js', 'examples/stub.js'));
});

test('an import map never overrides a workspace package of the same name', async () => {
  const g = await scan(project({
    'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
    'packages/ui/package.json': JSON.stringify({ name: 'ui', main: 'src.js' }),
    'packages/ui/src.js': 'export const a = 1;',
    'packages/ui/bundle.js': 'export const a = 1;',
    'index.html': '<script type="importmap">{ "imports": { "ui": "/packages/ui/bundle.js" } }</script>',
    'app.js': "import { a } from 'ui';",
  }));
  assert.ok(edge(g, 'app.js', 'packages/ui/src.js'));
  assert.ok(!edge(g, 'app.js', 'packages/ui/bundle.js'));
});

test('a nested jsconfig/tsconfig applies to its own directory only', async () => {
  const files = {
    'package.json': '{}',
    'assets/jsconfig.json': '{ "compilerOptions": { "baseUrl": "./", "paths": { "@theme/*": ["./*"] } } }',
    'assets/cart.js': "import '@theme/component';",
    'assets/component.js': 'export {};',
    'other/x.js': "import '@theme/component';",
  };
  const g = await scan(project(files));
  assert.ok(edge(g, 'assets/cart.js', 'assets/component.js'));
  assert.ok(!edge(g, 'other/x.js', 'assets/component.js'));
});

test('nested configs: the deepest wins, the root one is the fallback, a sibling prefix does not leak', () => {
  const root = project({
    'tsconfig.json': '{ "compilerOptions": { "baseUrl": ".", "paths": { "~/*": ["./src/*"], "#r": ["./r.ts"] } } }',
    'pkg/a/tsconfig.json': '{ "compilerOptions": { "paths": { "~/*": ["./lib/*"] } } }',
  });
  const rules = loadAliases(root, ['pkg/a/tsconfig.json', 'pkg/a/x.ts', 'tsconfig.json']);
  assert.equal(expandAlias('~/x', rules, 'pkg/a')[0], 'pkg/a/lib/x');
  assert.equal(expandAlias('~/x', rules, 'pkg/a/deep')[0], 'pkg/a/lib/x');
  assert.equal(expandAlias('#r', rules, 'pkg/a')[0], 'r.ts');
  assert.equal(expandAlias('~/x', rules, 'pkg/ab')[0], 'src/x');
  assert.equal(expandAlias('~/x', rules)[0], 'src/x');
});

test('liquid inline scripts: bare imports and custom elements count, relative imports do not', async () => {
  const { refs, defines } = liquid([
    '<script type="module">',
    "  import { a } from '@theme/a';",
    "  import './b.js';",
    "  import { c } from 'https://cdn.example.com/c.js';",
    "  customElements.define('in-liquid', class extends HTMLElement {});",
    '</script>',
    '<script type="application/json">import x from "nope"</script>',
    '{% javascript %}',
    "  customElements.define('in-tag', class extends HTMLElement {});",
    '{% endjavascript %}',
  ].join('\n'));
  assert.deepEqual(refs.filter(r => r.rel === 'import').map(r => [r.target, r.line]), [['@theme/a', 2]]);
  assert.deepEqual(defines, ['in-liquid', 'in-tag']);

  const g = await theme({
    'snippets/def.liquid': "<script>customElements.define('my-el', class extends HTMLElement {});</script>",
    'sections/use.liquid': '<my-el></my-el>',
  });
  assert.equal(edge(g, 'sections/use.liquid', 'snippets/def.liquid')?.rel, 'custom_element');
  assert.deepEqual(g.unresolved, []);
});

test('inline scripts: one in an HTML comment is dead, and a real module wins over an inline define', async () => {
  const define = "customElements.define('my-el', class extends HTMLElement {});";
  assert.deepEqual(liquid(`<!-- <script>${define}</script> -->`).defines, []);
  const g = await theme({
    'sections/a.liquid': `<script>${define}</script>`,
    'src/my-el.js': define,
    'snippets/use.liquid': '<my-el></my-el>',
  });
  assert.ok(edge(g, 'snippets/use.liquid', 'src/my-el.js'));
});

// ── 2. {% schema %} blocks ──────────────────────────────────────────────────

test('schema: blocks, presets and default name theme blocks; placeholders and local blocks do not', () => {
  const { refs, localBlocks } = liquid(schema({
    name: 'S',
    settings: [{ type: 'slide', id: 'x' }],
    blocks: [{ type: 'slide' }, { type: '@theme' }, { type: '@app' }, { type: 'local', name: 'Local', settings: [] }],
    presets: [{ name: 'P', blocks: [{ type: 'group', blocks: { t: { type: 'text' } } }, { type: 'local' }, { type: 'shopify://apps/a' }] }],
    default: { blocks: [{ type: 'button' }] },
  }));
  assert.deepEqual(refs.map(r => [r.rel, r.target, r.value]), [
    ['content_for', 'slide', 'schema_block'],
    ['content_for', 'group', 'schema_block'],
    ['content_for', 'text', 'schema_block'],
    ['content_for', 'button', 'schema_block'],
  ]);
  assert.deepEqual(localBlocks, ['local']);
});

test('schema: line points at the block, not at a setting of the same type', () => {
  const content = '<div>\n' + schema({ settings: [{ type: 'text', id: 'a' }], blocks: [{ type: 'text' }] });
  const { refs } = liquid(content);
  assert.equal(refs[0].line, content.split('\n').findLastIndex(l => l.includes('"type": "text"')) + 1);
});

test('schema: trailing commas are tolerated, broken JSON and odd shapes are ignored', () => {
  assert.deepEqual(liquid('{% schema %}{ "blocks": [{ "type": "a" }, ], }{% endschema %}').refs.map(r => r.target), ['a']);
  for (const body of ['{ nope', '[]', 'null', '"x"', '{ "blocks": "x", "presets": {}, "default": 1 }', '{ "blocks": [null, 1, {}] }']) {
    const r = liquid(`{%- schema -%}${body}{%- endschema -%}`);
    assert.deepEqual([r.refs, r.localBlocks], [[], []], body);
  }
});

test('schema edges rescue blocks from the orphans, and mutual nesting is not a cycle', async () => {
  const g = await theme({
    'sections/main.liquid': schema({ blocks: [{ type: 'group' }, { type: 'ghost' }] }),
    'blocks/group.liquid': schema({ blocks: [{ type: 'accordion' }, { type: 'group' }] }),
    'blocks/accordion.liquid': schema({ blocks: [{ type: 'group' }] }),
    'blocks/unused.liquid': schema({ name: 'Unused' }),
  });
  assert.equal(edge(g, 'sections/main.liquid', 'blocks/group.liquid')?.value, 'schema_block');
  assert.deepEqual(g.nodes.filter(n => n.orphan && n.type === 'block').map(n => n.id), ['blocks/unused.liquid']);
  assert.deepEqual(g.cycles, []);
  assert.deepEqual(g.warnings, []);
  assert.deepEqual(missing(g), []);
  assert.ok(!g.edges.some(e => e.from === e.to));
});

test('a real render cycle is still reported', async () => {
  const g = await theme({ 'snippets/a.liquid': "{% render 'b' %}", 'snippets/b.liquid': "{% render 'a' %}" });
  assert.equal(g.cycles.length, 1);
});

// ── 3, 5, 6. liquid filters and tags ────────────────────────────────────────

test('inline_asset_content is an asset reference', async () => {
  const g = await theme({
    'snippets/icon.liquid': "{{- 'icon-cart.svg' | inline_asset_content -}}",
    'assets/icon-cart.svg': '<svg/>',
    'assets/icon-dead.svg': '<svg/>',
  });
  assert.equal(edge(g, 'snippets/icon.liquid', 'assets/icon-cart.svg')?.rel, 'asset_url');
  assert.equal(node(g, 'assets/icon-cart.svg')?.orphan, false);
  assert.equal(node(g, 'assets/icon-dead.svg')?.orphan, true);
});

test('asset and t filters work with whitespace control, chained filters, and in any tag', () => {
  const { refs } = liquid([
    "{{- 'a.css' | asset_url | stylesheet_tag: preload: true -}}",
    "{%- assign b = 'b.js' | asset_url -%}",
    '{% capture c %}{{ "c.png" | asset_img_url: "100x" }}{% endcapture %}',
    "{{- 'k.one' | t -}}",
    "{{ 'k.two' | t: name: shop.name | escape }}",
    "{% assign label = 'k.three' | t %}",
    '<link href="{{ \'d.css\' | asset_url }}">',
  ].join('\n'));
  assert.deepEqual(refs.map(r => [r.rel, r.target, r.line]), [
    ['asset_url', 'a.css', 1], ['asset_url', 'b.js', 2], ['asset_url', 'c.png', 3],
    ['translation', 'k.one', 4], ['translation', 'k.two', 5], ['translation', 'k.three', 6],
    ['asset_url', 'd.css', 7],
  ]);
});

test("a literal that is another filter's argument is not a file name", () => {
  assert.deepEqual(liquid([
    "{{ name | append: '.svg' | asset_url }}",
    "{{ 'icon-' | append: name | append: '.svg' | inline_asset_content }}",
    "{{ name | replace: 'a', 'b' | asset_url }}",
    "{{ name | replace: 'a','' | asset_url }}",
    "{{- '?' | asset_url | json -}}",
    "{{ 'x.js' | shopify_asset_url }} {{ 'x' | truncate }} {{ x | default: 'k' | append: 'y' | t }}",
    "it's {{ icon | asset_url }} isn't",
  ].join('\n')).refs, []);
});

test('a % inside tag arguments does not break the tag', () => {
  const { refs } = liquid([
    "{% render 'text', width: '100%', block: block %}",
    "{%- render 'other', a: '5%' , b: '%' -%}",
    "{% content_for 'block', type: 'slide', id: 'x', w: '50%' %}",
    "{% if a %}100%{% endif %}{% render 'last' %}",
  ].join('\n'));
  assert.deepEqual(refs.map(r => [r.target, r.line]), [['text', 1], ['other', 2], ['last', 4], ['slide', 3]]);
});

test('an unclosed tag does not swallow the next one', () => {
  const { refs } = liquid("<!-- use {% render to include -->\n{% render 'b' %}\n{% render 'c', x: { %}");
  assert.deepEqual(refs.map(r => [r.target, r.line]), [['b', 2], ['c', 3]]);
});

test('a translation key needs no ASCII letters', () => {
  assert.deepEqual(liquid("{{ 'キー' | t }}").refs.map(r => r.target), ['キー']);
});

test('a % in a reassignment still makes the name ambiguous', () => {
  const r = liquid("{% assign s = 'card' %}{% assign s = x | append: '%' %}{% render s %}").refs;
  assert.equal(r[0].literal, false);
});

test('inline comments and comments inside {% liquid %} produce no refs, lines hold', () => {
  assert.deepEqual(liquid("{%- comment app_begin -%}{% render 'x' %}{%- endcomment app_end -%}").refs, []);
  const { refs } = liquid([
    "{% # render 'a' and 'a.js' | asset_url %}",
    '{% liquid',
    "  # assign u = 'b.js' | asset_url",
    '  comment',
    "    render 'c'",
    '  endcomment',
    "  render 'd'",
    '%}',
    "{% render 'e' %}",
  ].join('\n'));
  assert.deepEqual(refs.map(r => [r.target, r.line]).sort(), [['d', 7], ['e', 9]]);
});

// ── 4. local vs theme blocks in JSON ────────────────────────────────────────

test('a JSON block its section defines locally is not the theme block of the same name', async () => {
  const g = await theme({
    'sections/rich-text.liquid': schema({ blocks: [{ type: 'heading', name: 'Heading', settings: [] }] }),
    'sections/modern.liquid': schema({ blocks: [{ type: '@theme' }] }),
    'blocks/heading.liquid': 'x',
    'blocks/text.liquid': 'x',
    'templates/local.json': JSON.stringify({ sections: { a: { type: 'rich-text', blocks: { b: { type: 'heading' } } } } }),
    'templates/theme.json': JSON.stringify({ sections: { a: { type: 'modern', blocks: { b: { type: 'text', blocks: { c: { type: 'heading' } } } } } } }),
    // Scanned before sections/rich-text.liquid: the schema must still be known.
    'sections/a-group.json': JSON.stringify({ sections: { a: { type: 'rich-text', blocks: { b: { type: 'heading' } } } } }),
  });
  assert.ok(!edge(g, 'templates/local.json', 'blocks/heading.liquid'));
  assert.ok(!edge(g, 'sections/a-group.json', 'blocks/heading.liquid'));
  assert.ok(edge(g, 'templates/theme.json', 'blocks/text.liquid'));
  assert.ok(edge(g, 'templates/theme.json', 'blocks/heading.liquid'), 'a nested block is always a theme block');
  for (const n of g.nodes) {
    assert.equal(n.out, g.edges.filter(e => e.from === n.id).length, n.id);
    assert.equal(n.in, g.edges.filter(e => e.to === n.id).length, n.id);
  }
});

// ── 7. false missing files ──────────────────────────────────────────────────

test('asset_url finds assets/<name>.liquid, and still reports what is really absent', async () => {
  const g = await theme({
    'snippets/css.liquid': "{{ 'check.svg' | asset_url }} {{ 'both.css' | asset_url }} {{ 'gone.svg' | asset_url }}",
    'assets/check.svg.liquid': '<svg/>',
    'assets/both.css': 'a{}',
    'assets/both.css.liquid': 'a{}',
  });
  assert.ok(edge(g, 'snippets/css.liquid', 'assets/check.svg.liquid'));
  assert.ok(edge(g, 'snippets/css.liquid', 'assets/both.css'));
  assert.deepEqual(missing(g), ['assets/gone.svg']);
});

test('files over 2 MB exist: binaries are plain leaves, text is a leaf with a warning', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024 + 1);
  const root = project({
    'config/settings_schema.json': '[]',
    'sections/v.liquid': "{{ 'bg.mp4' | asset_url }} {{ 'huge.js' | asset_url }}",
    'assets/bg.mp4': big,
    'assets/huge.js': big,
    'assets/unreferenced.js': big,
  });
  const { tooLarge, binaryLeaves } = await collectFiles(root);
  assert.deepEqual(tooLarge, ['assets/huge.js', 'assets/unreferenced.js']);
  assert.deepEqual(binaryLeaves.map(b => b.id), ['assets/bg.mp4']);

  const g = await scan(root);
  assert.deepEqual(missing(g), []);
  assert.ok(edge(g, 'sections/v.liquid', 'assets/bg.mp4'));
  assert.ok(edge(g, 'sections/v.liquid', 'assets/huge.js'));
  assert.deepEqual(g.warnings.map(w => [w.code, w.file]), [
    ['file_too_large', 'assets/huge.js'], ['file_too_large', 'assets/unreferenced.js'],
  ]);
  rmSync(root, { recursive: true, force: true });
});

test("css: an inline SVG's own url() is not a file", () => {
  const { refs } = scanCss({
    id: 'a.css',
    content: [
      `a { content: url("data:image/svg+xml,%3Csvg width='12' clip-path='url(%23clip0)'%3E"); }`,
      `b { background: url('x.png'), url("y.png"), url( z.png ), url("it's.png"); }`,
      `c { background: url("https://cdn.example.com/q.png"); mask: url(#m); }`,
    ].join('\n'),
  });
  assert.deepEqual(refs.filter(r => r.literal).map(r => r.target), ['x.png', 'y.png', 'z.png', "it's.png"]);
  assert.deepEqual(refs.filter(r => !r.literal).map(r => r.value), ['external']);
});

test('css: a template or interpolation inside a quoted url() is not a file', () => {
  const { refs } = scanCss({
    id: 'a.scss',
    content: `a { b: url("{{ 'x.png' | asset_url }}"); c: url("{% static 'x.png' %}"); d: url("img/#{map-get($m, 'x')}.png"); e: url("f{1}.png"); }`,
  });
  assert.deepEqual(refs.map(r => r.target), ['f{1}.png']);
});

test('require() inside a theme bundle is not a missing file, outside a theme it is', async () => {
  const g = await theme({ 'assets/vendor.js': "module.exports = require('./cell'); require('./real');", 'assets/real.js': '' });
  assert.deepEqual(missing(g), []);
  assert.ok(edge(g, 'assets/vendor.js', 'assets/real.js'));
  assert.deepEqual(g.unresolved.map(u => [u.reason, u.hint]), [['external', 'require() resolved inside a browser bundle']]);

  const build = await theme({ 'scripts/build.js': "require('./gone');", 'gulpfile.js': "require('./tasks/nope');" });
  assert.deepEqual(missing(build), ['scripts/gone', 'tasks/nope']);

  const js = await scan(project({ 'package.json': '{}', 'a.js': "require('./cell');" }));
  assert.deepEqual(missing(js), ['cell']);
});

test('the apps section falls back to _blocks.liquid, then to the one Shopify provides', async () => {
  const tpl = { 'templates/cart.json': JSON.stringify({ sections: { a: { type: 'apps' }, b: { type: 'gone' } } }) };
  const platform = await theme(tpl);
  assert.deepEqual(missing(platform), ['sections/gone.liquid']);
  assert.equal(platform.unresolved[0].hint, 'section provided by Shopify, not a theme file');
  const blocks = await theme({ ...tpl, 'sections/_blocks.liquid': 'x' });
  assert.ok(edge(blocks, 'templates/cart.json', 'sections/_blocks.liquid'));
  const own = await theme({ ...tpl, 'sections/_blocks.liquid': 'x', 'sections/apps.liquid': 'x' });
  assert.ok(edge(own, 'templates/cart.json', 'sections/apps.liquid'));
});

// ── 8. staleness ────────────────────────────────────────────────────────────

test('staleFiles: an added file is stale, ignored and older files are not', async () => {
  const root = project({ 'package.json': '{}', 'a.js': '', '.gitignore': 'gen/\n' });
  const g = await scan(root);
  g.scannedAt = new Date(Date.now() + 2000).toISOString();
  assert.deepEqual(staleFiles(g), []);

  mkdirSync(path.join(root, 'gen'));
  mkdirSync(path.join(root, 'new'));
  writeFileSync(path.join(root, 'gen/ignored.js'), '');
  writeFileSync(path.join(root, 'new/added.js'), '');
  assert.deepEqual(staleFiles(g), [], 'present before the scan and left out of it (--ignore)');

  g.scannedAt = new Date(Date.now() - 60_000).toISOString();
  const old = new Date(Date.now() - 3_600_000);
  for (const f of ['package.json', 'a.js', 'new/added.js']) utimesSync(path.join(root, f), old, old);
  // Copied in with an old mtime: its creation time still gives it away.
  assert.deepEqual(staleFiles(g), ['new/added.js', '.gitignore']);

  rmSync(path.join(root, 'a.js'));
  assert.deepEqual(staleFiles(g), ['a.js', 'new/added.js', '.gitignore']);
});

test('staleFiles: an edited .gitignore is stale; one inside an ignored directory is not', async () => {
  const root = project({
    'package.json': '{}', '.gitignore': 'gen/\n', 'pkg/.gitignore': 'x\n',
    'gen/.gitignore': 'x\n', 'a/dist/.gitignore': 'x\n', '.ruff_cache/.gitignore': '*\n',
  });
  const g = await scan(root);
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(path.join(root, 'package.json'), old, old);
  g.scannedAt = new Date(Date.now() + 2000).toISOString();
  assert.deepEqual(staleFiles(g), []);
  g.scannedAt = new Date(Date.now() - 60_000).toISOString();
  assert.deepEqual(staleFiles(g), ['.gitignore', 'pkg/.gitignore']);
});

test('listFiles: skipIgnoredDirs keeps the relevant list identical', () => {
  const root = project({
    '.gitignore': 'gen\n/out/\n!out/keep.js\ncache/*\n!cache/keep.js\n!dist/\n*.log\n', '.nervegraphignore': 'skip/\n',
    'gen/a.js': '', 'sub/gen/b.js': '', 'out/keep.js': '', 'cache/keep.js': '', 'cache/x.js': '', 'dist/d.js': '',
    '(odd) [dir]/x.js': '', 'skip/s.js': '', 'a.log': '', 'src/a.js': '',
  });
  const full = listFiles(root), fast = listFiles(root, { skipIgnoredDirs: true });
  assert.deepEqual(fast.relevant, full.relevant);
  assert.deepEqual(full.relevant, ['(odd) [dir]/x.js', '.nervegraphignore', 'cache/keep.js', 'src/a.js']);
  assert.ok(full.ignored.includes('gen/a.js') && !fast.ignored.includes('gen/a.js'));
});

test('staleFiles: an edited root .gitignore that matches itself is stale', async () => {
  for (const content of ['.*\n', '.gitignore\n', '*\n!*/\n!*.json\n']) {
    const root = project({ 'package.json': '{}', '.gitignore': content });
    const g = await scan(root);
    g.scannedAt = new Date(Date.now() - 60_000).toISOString();
    assert.ok(staleFiles(g).includes('.gitignore'), JSON.stringify(content));
  }
});

test('staleFiles: a directory named .gitignore does not throw', async () => {
  const root = project({ 'package.json': '{}', '.gitignore/x.js': '' });
  assert.deepEqual(staleFiles(await scan(root)), []);
});

test("staleFiles: the scan's own output inside the project does not make it stale forever", async () => {
  const root = project({ 'package.json': '{}', 'a.js': '' });
  const out = path.join(root, 'out');
  for (let i = 0; i < 2; i++) {
    const g = await scan(root);
    g.scannedAt = new Date(Date.now() - 60_000).toISOString();
    const old = new Date(Date.now() - 3_600_000);
    for (const f of ['package.json', 'a.js']) utimesSync(path.join(root, f), old, old);
    await writeGraphAtomic(out, g);
    // Second round: graph.json is a node of the graph itself.
    const graphPath = path.join(out, 'graph.json');
    assert.deepEqual(staleFiles(g, graphPath), []);
    if (process.platform === 'win32') assert.deepEqual(staleFiles(g, graphPath.toLowerCase()), []);
  }
});

test('staleFiles: a missing root does not throw', async () => {
  const g = await scan(project({ 'package.json': '{}' }));
  g.root = path.join(tmpdir(), 'nervegraph-no-such-dir');
  assert.deepEqual(staleFiles(g), ['package.json']);
});

// ── 9. Shopify conventions ──────────────────────────────────────────────────

test('config files and block wrappers are entrypoints, not orphans', async () => {
  const g = await theme({
    'config/settings_data.json': '{}', 'config/markets.json': '{}',
    'sections/_blocks.liquid': 'x', 'sections/apps.liquid': 'x', 'sections/unused.liquid': 'x',
  });
  assert.deepEqual(g.nodes.filter(n => n.orphan).map(n => n.id), ['sections/unused.liquid']);
});

test('section rendering API: every spelling of a section id', () => {
  const names = (s: string) => sectionApiRefs(s).map(r => r.target);
  assert.deepEqual(names("`${url}?q=1&section_id=predictive-search`"), ['predictive-search']);
  assert.deepEqual(names("url.searchParams.set('section_id', 'card')"), ['card']);
  assert.deepEqual(names("const QUICK_ADD_SECTION_ID = 'quick-add';"), ['quick-add']);
  assert.deepEqual(names("const emptySectionId = `empty`;"), ['empty']);
  assert.deepEqual(names('<div data-section-id="search">'), ['search']);
  assert.deepEqual(names("{% render 'x', section_id: 'cart-drawer' %}"), ['cart-drawer']);
  assert.deepEqual(names("fetch('/cart?sections=a,b')"), ['a', 'b']);
  assert.deepEqual(names("body.append( 'section_id', 'mini' )"), ['mini']);
  assert.deepEqual(names(`['sectionId', 'header'] { "id": "section_id", "label": "main" }`), []);
  assert.deepEqual(names('section_id=${id} data-section-id="{{ section.id }}" sectionId = section; this.sectionId'), []);
});

test('section rendering API: real sections get an edge, ids and comments do not, loops are not cycles', async () => {
  const g = await theme({
    'assets/search.js': [
      "// old: ?section_id=commented",
      "customElements.define('my-search', class extends HTMLElement {});",
      "fetch(`/search?section_id=results`); fetch('/x?section_id=template--1__main');",
    ].join('\n'),
    'sections/results.liquid': '<my-search data-section-id="results"></my-search>',
    'sections/commented.liquid': 'x',
  });
  assert.equal(edge(g, 'assets/search.js', 'sections/results.liquid')?.value, 'section_api');
  assert.equal(edge(g, 'assets/search.js', 'sections/results.liquid')?.line, 3);
  assert.ok(!edge(g, 'sections/results.liquid', 'sections/results.liquid'));
  assert.equal(node(g, 'sections/commented.liquid')?.orphan, true);
  assert.deepEqual(g.cycles, []);
  assert.deepEqual(missing(g), []);
  assert.deepEqual(g.unresolved, []);
});

test('section ids mean nothing outside a theme', async () => {
  const g = await scan(project({ 'package.json': '{}', 'a.js': "const sectionId = 'main';" }));
  assert.deepEqual([g.edges, g.unresolved, missing(g)], [[], [], []]);
  assert.equal(scanJavaScript({ id: 'a.js', content: "const s = 'section';" }).refs.length, 0);
});

// ── 10. noise ───────────────────────────────────────────────────────────────

test('OS and tool metadata is not scanned, but a link to it is not broken', async () => {
  const root = project({
    'package.json': '{}', '.DS_Store': 'x', '.gitignore': 'x.log\n', 'x.log': '', '.gitattributes': '',
    '.claude/settings.local.json': '{}', '.claude/worktrees/w/a.js': '', '.claude/hooks/h.js': '',
    'sub/.claude/worktrees/w/a.js': '', 'sub/.claude/settings.json': '{}', 'sub/dist/a.js': '', 'sub/.DS_Store': 'x',
    '.github/ci.yml': '', 'README.md': '[settings](.claude/settings.local.json)',
  });
  assert.deepEqual(listFiles(root).relevant, ['.claude/hooks/h.js', '.github/ci.yml', 'README.md', 'package.json']);
  const g = await scan(root);
  assert.deepEqual(g.nodes.map(n => n.id), ['.claude/hooks/h.js', '.claude/settings.local.json', '.github/ci.yml', 'README.md', 'package.json']);
  assert.deepEqual(missing(g), []);
});

// ── speed ───────────────────────────────────────────────────────────────────

// Each took 10 s to over a minute while quadratic; linear they take milliseconds.
test('big or malformed input does not blow up', () => {
  const rows = (s: string, size = 512 * 1024) => s.repeat(Math.ceil(size / s.length));
  const cases: [string, () => unknown][] = [
    ['unclosed tags', () => liquid(rows("{% render 'x' "))],
    ['section ids', () => sectionApiRefs(rows('{ sectionId: "abc", title: 1 }\n'))],
    ['translations', () => liquid(rows("{{ 'a.b' | t }}\n"))],
    ['import map types', () => page('<script ' + rows('type=importmap '))],
    ['a section list in a URL', () => scanJavaScript({ id: 'a.js', content: rows('&sections=a,b,c', 2 * 1024 * 1024) })],
    ['unclosed import maps', () => page(rows('<script type=importmap ', 64 * 1024))],
  ];
  for (const [name, run] of cases) {
    const t = Date.now();
    run();
    assert.ok(Date.now() - t < 4000, `${name}: ${Date.now() - t} ms`);
  }
});

test('many nested configs sharing one paths table stay cheap per import', () => {
  const rules = Array.from({ length: 200 }, (_, d) => Array.from({ length: 200 }, (_, p) =>
    ({ prefix: `@lib/${p}`, targets: [`libs/${p}`], scope: `libs/${d}` }))).flat();
  const t = Date.now();
  // Ten directories per package: the scope filter runs once for each of them.
  for (let i = 0; i < 20_000; i++) assert.equal(expandAlias('@lib/7', rules, `libs/${i % 200}/d${i % 2000}`).length, 1);
  assert.ok(Date.now() - t < 4000, `${Date.now() - t} ms`);
});

test('line numbers hold when queries jump back and between files', () => {
  assert.deepEqual([lineAt('a\nb\nc', 4), lineAt('a\nb\nc', 2), lineAt('x\ny', 2), lineAt('a\nb\nc', 4), lineAt('a\nb\nc', 0)], [3, 2, 2, 3, 1]);
});
