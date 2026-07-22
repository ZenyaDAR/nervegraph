import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRefs } from '../src/graph/resolve.ts';
import type { RawRef, RelType } from '../src/graph/types.ts';

function ctx(existing: string[]) {
  const set = new Set(existing.map(s => s.toLowerCase()));
  return { profile: 'js' as const, fileExists: (id: string) => set.has(id.toLowerCase()) };
}

function one(from: string, rel: RelType, target: string, existing: string[]) {
  const refs: RawRef[] = [{ rel, target, line: 1, raw: '', literal: true }];
  return resolveRefs(from, refs, ctx(existing));
}

// ── Python ─────────────────────────────────────────────────────────────────

test('python: dotted import resolves to a module file', () => {
  const out = one('main.py', 'py_import', 'pkg.mod', ['pkg/mod.py']);
  assert.equal(out.edges[0].to, 'pkg/mod.py');
});

test('python: a package resolves to its __init__.py', () => {
  const out = one('main.py', 'py_import', 'pkg', ['pkg/__init__.py']);
  assert.equal(out.edges[0].to, 'pkg/__init__.py');
});

test('python: src/ and lib/ layouts are searched', () => {
  assert.equal(one('main.py', 'py_import', 'app.util', ['src/app/util.py']).edges[0].to, 'src/app/util.py');
  assert.equal(one('main.py', 'py_import', 'app.util', ['lib/app/util.py']).edges[0].to, 'lib/app/util.py');
});

test('python: from pkg import name falls back to the package when name is not a module', () => {
  // `from pkg import helper` where helper is defined inside pkg/__init__.py
  const out = one('main.py', 'py_import', 'pkg.helper', ['pkg/__init__.py']);
  assert.equal(out.edges[0].to, 'pkg/__init__.py');
});

test('python: a submodule wins over the package when both exist', () => {
  const out = one('main.py', 'py_import', 'pkg.mod', ['pkg/__init__.py', 'pkg/mod.py']);
  assert.equal(out.edges[0].to, 'pkg/mod.py');
});

test('python: single-dot relative import is the current package', () => {
  const out = one('app/views.py', 'py_import', '.models', ['app/models.py']);
  assert.equal(out.edges[0].to, 'app/models.py');
});

test('python: double-dot relative import climbs one level', () => {
  const out = one('app/api/views.py', 'py_import', '..models', ['app/models.py']);
  assert.equal(out.edges[0].to, 'app/models.py');
});

test('python: a stdlib or pip import is external, not a missing node', () => {
  const out = one('main.py', 'py_import', 'os.path', []);
  assert.equal(out.edges.length, 0);
  assert.equal(out.unresolved[0].reason, 'external');
});

test('python: a broken relative import IS reported missing', () => {
  const out = one('app/views.py', 'py_import', '.ghost', []);
  assert.equal(out.edges[0].to, 'app/ghost.py');
  assert.ok(out.missingTargets.has('app/ghost.py'));
});

test('python: a relative import escaping the project root is external', () => {
  const out = one('a.py', 'py_import', '..outside', []);
  assert.equal(out.edges.length, 0);
  assert.equal(out.unresolved[0].reason, 'external');
});

test('python: .pyi stubs resolve', () => {
  assert.equal(one('main.py', 'py_import', 'typings', ['typings.pyi']).edges[0].to, 'typings.pyi');
});

// ── Ruby ───────────────────────────────────────────────────────────────────

test('ruby: require_relative resolves against the requiring file', () => {
  const out = one('lib/thing.rb', 'rb_require_relative', 'helper', ['lib/helper.rb']);
  assert.equal(out.edges[0].to, 'lib/helper.rb');
});

test('ruby: require_relative with an explicit .rb extension', () => {
  const out = one('lib/thing.rb', 'rb_require_relative', 'helper.rb', ['lib/helper.rb']);
  assert.equal(out.edges[0].to, 'lib/helper.rb');
});

test('ruby: a broken require_relative is missing, since it must be a project file', () => {
  const out = one('lib/thing.rb', 'rb_require_relative', 'ghost', []);
  assert.equal(out.edges[0].to, 'lib/ghost.rb');
  assert.ok(out.missingTargets.has('lib/ghost.rb'));
});

test('ruby: require searches lib/ and app/', () => {
  assert.equal(one('main.rb', 'rb_require', 'thing', ['lib/thing.rb']).edges[0].to, 'lib/thing.rb');
  assert.equal(one('main.rb', 'rb_require', 'thing', ['app/thing.rb']).edges[0].to, 'app/thing.rb');
});

test('ruby: a gem require is external, never a missing node', () => {
  const out = one('main.rb', 'rb_require', 'json', []);
  assert.equal(out.edges.length, 0);
  assert.equal(out.unresolved[0].reason, 'external');
});

// ── Rust ───────────────────────────────────────────────────────────────────

test('rust: mod in a crate root resolves to a sibling file', () => {
  const out = one('src/lib.rs', 'rust_mod', 'parser', ['src/parser.rs']);
  assert.equal(out.edges[0].to, 'src/parser.rs');
});

test('rust: mod falls back to the directory form', () => {
  const out = one('src/lib.rs', 'rust_mod', 'parser', ['src/parser/mod.rs']);
  assert.equal(out.edges[0].to, 'src/parser/mod.rs');
});

test('rust: a nested mod resolves under its parent module directory', () => {
  // scanners/rust.ts prefixes the target with the parent module's directory
  const out = one('src/parser.rs', 'rust_mod', 'parser/lexer', ['src/parser/lexer.rs']);
  assert.equal(out.edges[0].to, 'src/parser/lexer.rs');
});

test('rust: a declared but absent mod is missing — the crate would not compile', () => {
  const out = one('src/lib.rs', 'rust_mod', 'ghost', []);
  assert.equal(out.edges[0].to, 'src/ghost.rs');
  assert.ok(out.missingTargets.has('src/ghost.rs'));
});

// ── Root-absolute paths (regression) ───────────────────────────────────────

test('a root-absolute src resolves from the project root, not the referencing dir', () => {
  const out = one('pages/about.html', 'script_src', '/assets/app.js', ['assets/app.js']);
  assert.equal(out.edges[0].to, 'assets/app.js');
});

test('a directory-relative src still resolves against the referencing file', () => {
  const out = one('pages/about.html', 'script_src', 'app.js', ['pages/app.js']);
  assert.equal(out.edges[0].to, 'pages/app.js');
});

test('css url() is path-shaped even under the shopify profile', () => {
  // Regression: `asset` used to be the Shopify convention lookup, so a theme
  // stylesheet's url("../fonts/x.woff") produced the id "assets/../fonts/x.woff".
  const refs: RawRef[] = [{ rel: 'asset', target: '../fonts/x.woff', line: 1, raw: '', literal: true }];
  const set = new Set(['fonts/x.woff']);
  const out = resolveRefs('assets/theme.css', refs, {
    profile: 'shopify',
    fileExists: (id: string) => set.has(id),
  });
  assert.equal(out.edges[0].to, 'fonts/x.woff');
});
