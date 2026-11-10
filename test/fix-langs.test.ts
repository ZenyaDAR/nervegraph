import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildGraph } from '../src/graph/build.ts';
import { resolveRefs, type ResolveContext } from '../src/graph/resolve.ts';
import type { RawRef } from '../src/graph/types.ts';
import { scanPython } from '../src/scan/scanners/python.ts';
import { scanLiquid } from '../src/scan/scanners/liquid.ts';
import { scanShopifyJson } from '../src/scan/scanners/shopify-json.ts';
import { scanCss } from '../src/scan/scanners/css.ts';
import { scanHtml, scanHtmlPage } from '../src/scan/scanners/html.ts';
import { scanMarkdown } from '../src/scan/scanners/markdown.ts';
import { scanRust } from '../src/scan/scanners/rust.ts';
import { scanTerraform } from '../src/scan/scanners/terraform.ts';
import { scanPhp } from '../src/scan/scanners/php.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'fix-langs');

function ctx(existing: string[], profile: ResolveContext['profile'] = 'poly'): ResolveContext {
  const set = new Set(existing.map(s => s.toLowerCase()));
  const listDir = (dir: string) => existing.filter(f => path.posix.dirname(f) === (dir || '.'));
  return { profile, fileExists: id => set.has(id.toLowerCase()), listDir };
}

const targets = (refs: RawRef[]) => refs.map(r => r.target);

// ── Python ──────────────────────────────────────────────────────────────────

test('python: CRLF line endings still yield imports', () => {
  const { refs } = scanPython({ id: 'a.py', content: 'import os\r\nfrom pkg import mod\r\n' });
  assert.deepEqual(targets(refs), ['os', 'pkg.mod']);
});

test('python: a multi-line parenthesised import keeps every name; docstrings are not code', () => {
  const content = '"""Usage:\nimport ghost\n"""\nfrom .sub import (\n    alpha,  # first\n    beta,\n)\nx = 1\n';
  const { refs } = scanPython({ id: 'pkg/a.py', content });
  assert.deepEqual(targets(refs), ['.sub.alpha', '.sub.beta']);
  assert.equal(refs[0].line, 4);
});

test('python: a missing relative module is one missing node, not one per imported name', () => {
  const refs = scanPython({ id: 'pkg/views.py', content: 'from .models import User, Group\n' }).refs;
  const out = resolveRefs('pkg/views.py', refs, ctx(['pkg/__init__.py', 'pkg/views.py']));
  assert.deepEqual([...out.missingTargets], ['pkg/models.py']);
});

test('python: a package outside src/ and lib/ resolves from an ancestor directory', () => {
  const refs = scanPython({ id: 'backend/tests/test_api.py', content: 'from app.models import User\nimport json\n' }).refs;
  const out = resolveRefs('backend/tests/test_api.py', refs, ctx(['backend/app/__init__.py', 'backend/app/models.py', 'backend/__init__.py']));
  assert.deepEqual(out.edges.map(e => e.to), ['backend/app/models.py']);
  // `import json` must not fall back onto backend/__init__.py
  assert.equal(out.unresolved.length, 1);
});

// ── Liquid / Shopify JSON ───────────────────────────────────────────────────

test('liquid: content_for blocks names no file; content_for block resolves its type', () => {
  const content = [
    "{% content_for 'blocks' %}",
    "{% content_for 'block', type: 'slide', id: 'hero' %}",
    '{% doc %}',
    "  {% render 'from-doc' %}",
    '{% enddoc %}',
    '{% liquid',
    "  content_for 'block', type: 'card', id: 'c'",
    "  echo 'theme.js' | asset_url | script_tag",
    "  render 'inner'",
    '%}',
  ].join('\n');
  const { refs } = scanLiquid({ id: 'sections/x.liquid', content });
  assert.deepEqual(refs.map(r => [r.rel, r.target, r.line]), [
    ['content_for', 'slide', 2],
    ['content_for', 'card', 7],
    ['asset_url', 'theme.js', 8],
    ['render', 'inner', 9],
  ]);
});

test('shopify json: nested theme blocks are refs, app/@theme blocks are not, schema-local types are dropped', () => {
  const content = JSON.stringify({
    sections: {
      main: {
        type: 'main',
        blocks: {
          s1: { type: 'slide', blocks: { t1: { type: 'text' } } },
          a1: { type: 'shopify://apps/reviews/blocks/stars/123' },
          p1: { type: '@app' },
        },
      },
    },
  }, null, 2);
  const { refs } = scanShopifyJson({ id: 'templates/index.json', content });
  assert.deepEqual(targets(refs), ['main', 'slide', 'text']);
  assert.equal(refs[1].line, content.split('\n').findIndex(l => l.includes('"slide"')) + 1);

  const out = resolveRefs('templates/index.json', refs, ctx(['sections/main.liquid', 'blocks/slide.liquid'], 'shopify'));
  assert.deepEqual(out.edges.map(e => e.to), ['sections/main.liquid', 'blocks/slide.liquid']);
  assert.equal(out.missingTargets.size, 0);
});

// ── CSS / Sass ──────────────────────────────────────────────────────────────

test('css: query/fragment are stripped, #id is not a file, sass builtins and @forward are handled', () => {
  const content = [
    '// a line comment that plain postcss would reject',
    "@use 'sass:math';",
    "@forward 'tokens';",
    "@import 'a', 'b';",
    '.i { src: url("font.woff2?v=3#iefix"); fill: url(#grad); background: url(//cdn.example.com/x.png); }',
  ].join('\n');
  const { refs } = scanCss({ id: 'styles/main.scss', content });
  assert.deepEqual(refs.filter(r => r.literal).map(r => [r.rel, r.target]), [
    ['css_import', 'tokens'],
    ['css_import', 'a'],
    ['css_import', 'b'],
    ['asset', 'font.woff2'],
  ]);
  const out = resolveRefs('styles/main.scss', refs, ctx(['styles/_tokens.scss', 'styles/_a.scss', 'styles/b.scss', 'styles/font.woff2']));
  assert.deepEqual(out.edges.map(e => e.to), ['styles/_tokens.scss', 'styles/_a.scss', 'styles/b.scss', 'styles/font.woff2']);
});

// ── HTML ────────────────────────────────────────────────────────────────────

test('html: ?v= and #x are stripped, href="/" is no node', () => {
  const { refs } = scanHtml({ id: 'index.html', content: '<script src="app.js?v=12"></script><link href="/"><img src="s.svg#icon">' });
  assert.deepEqual(targets(refs), ['app.js', 's.svg']);
});

test('html: inline module scripts are scanned for imports on the page, not in components', () => {
  const content = '<p>x</p>\n<script type="module">\nimport "./a.js";\n</script>\n<script type="application/json">{"import": "x"}</script>';
  const page = scanHtmlPage({ id: 'index.html', content }).refs;
  assert.deepEqual(page.map(r => [r.rel, r.target, r.line]), [['import', './a.js', 3]]);
  assert.equal(scanHtml({ id: 'index.html', content }).refs.length, 0);
});

test('html: a root-relative src missing at the project root falls back to the page directory', async () => {
  const g = await buildGraph({ root: FIXTURE });
  const has = (to: string, rel: string) => g.edges.some(e => e.from === 'viewer/index.html' && e.to === to && e.rel === rel);
  assert.ok(has('viewer/app.js', 'script_src'));
  assert.ok(has('viewer/util.js', 'import'));
  assert.ok(!g.nodes.some(n => n.id === '.' || n.id === 'app.js'));
  assert.ok(!g.nodes.some(n => n.missing));
});

// ── Markdown ────────────────────────────────────────────────────────────────

test('markdown: link targets are URL-decoded and lose their query', () => {
  const { refs } = scanMarkdown({ id: 'README.md', content: '[a](docs/my%20guide.md?plain=1#intro) [b](bad%zz.md)' });
  assert.deepEqual(targets(refs), ['docs/my guide.md', 'bad%zz.md']);
});

// ── Rust ────────────────────────────────────────────────────────────────────

test('rust: bin targets and build.rs are crate roots; same-line attributes; strings are not comments', () => {
  assert.deepEqual(targets(scanRust({ id: 'src/bin/tool.rs', content: 'mod cli;' }).refs), ['cli']);
  assert.deepEqual(targets(scanRust({ id: 'build.rs', content: 'mod gen;' }).refs), ['gen']);
  assert.deepEqual(targets(scanRust({ id: 'src/lib.rs', content: '#[cfg(test)] mod tests;\n#[path = "x.rs"] mod renamed;' }).refs), ['tests']);
  const content = 'const S: &str = "/*";\nmod real;\nconst E: &str = "*/";\n';
  assert.deepEqual(targets(scanRust({ id: 'src/lib.rs', content }).refs), ['real']);
});

// ── Terraform ───────────────────────────────────────────────────────────────

test('terraform: source is read only inside its module block, with the right line', () => {
  const content = [
    'variable "module" {',
    '  default = "x"',
    '}',
    '',
    'module "vpc" {',
    '  source = "./modules/vpc"',
    '}',
  ].join('\n');
  const { refs } = scanTerraform({ id: 'main.tf', content });
  assert.deepEqual(refs.map(r => [r.target, r.line]), [['./modules/vpc', 5]]);
});

// ── PHP ─────────────────────────────────────────────────────────────────────

test('php: a # inside a quoted path is not a comment', () => {
  const { refs } = scanPhp({ id: 'index.php', content: "<?php\nrequire 'lib#v2.php'; # trailing\n# require 'ghost.php';\n" });
  assert.deepEqual(targets(refs), ['lib#v2.php']);
});

// ── C ───────────────────────────────────────────────────────────────────────

test('c: include-root lookups are normalised', () => {
  const refs: RawRef[] = [{ rel: 'c_include', target: './util.h', line: 1, raw: '', literal: true }];
  const out = resolveRefs('src/deep/main.c', refs, ctx(['include/util.h']));
  assert.deepEqual(out.edges.map(e => [e.to, out.missingTargets.has(e.to)]), [['include/util.h', false]]);
});
