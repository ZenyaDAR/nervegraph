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

// ── wave B languages ───────────────────────────────────────────────────────

function polyCtx(files: string[], extra: Record<string, unknown> = {}) {
  const set = new Set(files);
  const dirs = new Map<string, string[]>();
  for (const f of files) {
    const i = f.lastIndexOf('/');
    const d = i < 0 ? '' : f.slice(0, i);
    dirs.set(d, [...(dirs.get(d) ?? []), f]);
  }
  return {
    profile: 'poly' as const,
    fileExists: (id: string) => set.has(id),
    listDir: (dir: string) => dirs.get(dir) ?? [],
    ...extra,
  };
}

test('go: own-module imports resolve to a package file, others stay external', () => {
  const c = polyCtx(['internal/store/store.go', 'internal/store/query.go', 'main.go'], { goModule: 'example.com/m' });
  const refs = (t: string): RawRef[] => [{ rel: 'go_import', target: t, line: 1, raw: '', literal: true }];

  assert.equal(resolveRefs('main.go', refs('example.com/m/internal/store'), c).edges[0].to, 'internal/store/store.go');
  assert.equal(resolveRefs('main.go', refs('fmt'), c).unresolved[0].reason, 'external');
  assert.equal(resolveRefs('main.go', refs('github.com/pkg/errors'), c).unresolved[0].reason, 'external');
  // A package the module claims but that isn't on disk is a real break.
  assert.ok(resolveRefs('main.go', refs('example.com/m/internal/gone'), c).missingTargets.has('internal/gone/gone.go'));
});

test('php: use resolves through the composer psr-4 map, require through the path', () => {
  const c = polyCtx(['src/Models/User.php', 'src/bootstrap.php'], {
    psr4: [{ prefix: 'App/*', targets: ['src/*'] }],
  });
  const use: RawRef[] = [{ rel: 'php_use', target: 'App\\Models\\User', line: 1, raw: '', literal: true }];
  const vendor: RawRef[] = [{ rel: 'php_use', target: 'Symfony\\Component\\Console', line: 2, raw: '', literal: true }];
  const req: RawRef[] = [{ rel: 'php_require', target: 'bootstrap.php', line: 3, raw: '', literal: true }];

  assert.equal(resolveRefs('src/Kernel.php', use, c).edges[0].to, 'src/Models/User.php');
  assert.equal(resolveRefs('src/Kernel.php', vendor, c).unresolved[0].reason, 'external');
  assert.equal(resolveRefs('src/Kernel.php', req, c).edges[0].to, 'src/bootstrap.php');
});

test('java: imports resolve under the maven source root, the JDK stays external', () => {
  const c = polyCtx(['src/main/java/app/svc/Store.java', 'src/main/kotlin/app/Util.kt']);
  const ref = (t: string): RawRef[] => [{ rel: 'java_import', target: t, line: 1, raw: '', literal: true }];

  assert.equal(resolveRefs('src/main/java/app/Main.java', ref('app.svc.Store'), c).edges[0].to, 'src/main/java/app/svc/Store.java');
  assert.equal(resolveRefs('src/main/java/app/Main.java', ref('app.Util'), c).edges[0].to, 'src/main/kotlin/app/Util.kt');
  // A nested class lives in its outer class's file.
  assert.equal(resolveRefs('src/main/java/app/Main.java', ref('app.svc.Store.Row'), c).edges[0].to, 'src/main/java/app/svc/Store.java');
  assert.equal(resolveRefs('src/main/java/app/Main.java', ref('java.util.List'), c).unresolved[0].reason, 'external');
});

test('c: includes resolve next to the file and under include/', () => {
  const c = polyCtx(['src/main.c', 'src/util.h', 'include/api.h']);
  const ref = (t: string): RawRef[] => [{ rel: 'c_include', target: t, line: 1, raw: '', literal: true }];

  assert.equal(resolveRefs('src/main.c', ref('util.h'), c).edges[0].to, 'src/util.h');
  assert.equal(resolveRefs('src/main.c', ref('api.h'), c).edges[0].to, 'include/api.h');
  assert.ok(resolveRefs('src/main.c', ref('gone.h'), c).missingTargets.has('src/gone.h'));
});

test('markdown: file links resolve, extensionless routes are external', () => {
  const c = polyCtx(['docs/02-cli.md', 'docs/guide/README.md', 'src/graph/build.ts']);
  const ref = (t: string): RawRef[] => [{ rel: 'md_link', target: t, line: 1, raw: '', literal: true }];

  assert.equal(resolveRefs('docs/index.md', ref('./02-cli.md'), c).edges[0].to, 'docs/02-cli.md');
  assert.equal(resolveRefs('docs/index.md', ref('guide'), c).edges[0].to, 'docs/guide/README.md');
  assert.equal(resolveRefs('docs/index.md', ref('../src/graph/build.ts'), c).edges[0].to, 'src/graph/build.ts');
  assert.equal(resolveRefs('docs/index.md', ref('getting-started'), c).unresolved[0].reason, 'external');
  assert.ok(resolveRefs('docs/index.md', ref('./gone.md'), c).missingTargets.has('docs/gone.md'));
});

test('shell and terraform resolve to the sourced file and the module directory', () => {
  const c = polyCtx(['scripts/build.sh', 'scripts/lib/log.sh', 'main.tf', 'modules/vpc/main.tf']);
  const sh: RawRef[] = [{ rel: 'sh_source', target: './lib/log.sh', line: 1, raw: '', literal: true }];
  const tf: RawRef[] = [{ rel: 'tf_module', target: './modules/vpc', line: 1, raw: '', literal: true }];

  assert.equal(resolveRefs('scripts/build.sh', sh, c).edges[0].to, 'scripts/lib/log.sh');
  assert.equal(resolveRefs('main.tf', tf, c).edges[0].to, 'modules/vpc/main.tf');
});
