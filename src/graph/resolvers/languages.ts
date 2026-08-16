import type { RelResolver, ResolveContext, ResolvedTarget } from './types.ts';
import { normalizeJoin } from './path-utils.ts';
import { expandAlias } from '../../scan/aliases.ts';

// Resolvers for languages whose module lookup isn't path-shaped the way JS and
// CSS are. All three are profile-agnostic: a Python package resolves the same
// way whether or not the surrounding repo is also a Shopify theme.
//
// Shared principle — a reference we can't find on disk is only "missing" when
// the syntax guarantees it must be a project file (a relative import, a
// require_relative, a `mod` declaration). A bare `import requests` or
// `require "json"` is a package/stdlib name, so it's reported external rather
// than inventing a missing node for every third-party dependency.

function firstExisting(candidates: string[], ctx: ResolveContext): string | undefined {
  return candidates.find(c => ctx.fileExists(c));
}

function dropLastSegment(p: string): string | undefined {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : undefined;
}

// ── Python ─────────────────────────────────────────────────────────────────

// Where a top-level dotted import may live. "" covers a flat repo, the other
// two the standard src/ and lib/ layouts.
const PY_ROOTS = ['', 'src/', 'lib/'];

function pyCandidates(base: string): string[] {
  return [`${base}.py`, `${base}/__init__.py`, `${base}.pyi`];
}

export function resolvePythonImport(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const dots = /^\.+/.exec(target)?.[0].length ?? 0;
  const bases: string[] = [];

  if (dots > 0) {
    // `from . import x` is the current package; each extra dot climbs one level.
    const up = Array(dots - 1).fill('..').join('/');
    const rest = target.slice(dots).replace(/\./g, '/');
    const base = normalizeJoin(fromDir, [up, rest].filter(Boolean).join('/') || '.');
    if (base.startsWith('..')) return 'external';
    bases.push(base);
  } else {
    const rel = target.replace(/\./g, '/');
    for (const root of PY_ROOTS) bases.push(`${root}${rel}`);
  }

  const exact = firstExisting(bases.flatMap(pyCandidates), ctx);
  if (exact) return { id: exact, missing: false };

  // `from pkg import name`: the scanner can't tell a submodule from a name
  // defined in pkg/__init__.py, so fall back to the package itself.
  const parents = bases.map(dropLastSegment).filter((p): p is string => !!p);
  const parent = firstExisting(parents.flatMap(pyCandidates), ctx);
  if (parent) return { id: parent, missing: false };

  // Relative imports must be project files, so an unfound one is a real break.
  if (dots > 0) return { id: `${bases[0]}.py`, missing: true };
  return 'external';
}

// ── Ruby ───────────────────────────────────────────────────────────────────

const RB_ROOTS = ['', 'lib/', 'app/', 'test/', 'spec/'];

function rbCandidates(base: string): string[] {
  return base.endsWith('.rb') ? [base] : [`${base}.rb`, base];
}

export function resolveRubyRequire(target: string, _fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const hit = firstExisting(RB_ROOTS.flatMap(root => rbCandidates(`${root}${target}`)), ctx);
  if (hit) return { id: hit, missing: false };
  return 'external'; // a gem, or stdlib
}

export function resolveRubyRequireRelative(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const base = normalizeJoin(fromDir, target);
  if (base.startsWith('..')) return 'external';
  const hit = firstExisting(rbCandidates(base), ctx);
  if (hit) return { id: hit, missing: false };
  return { id: base.endsWith('.rb') ? base : `${base}.rb`, missing: true };
}

// ── Rust ───────────────────────────────────────────────────────────────────

// The scanner has already prefixed the module name with its parent module's
// directory (see scanners/rust.ts), so this is a plain two-candidate lookup:
// `mod foo;` is either foo.rs or foo/mod.rs.
export function resolveRustMod(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const base = normalizeJoin(fromDir, target);
  if (base.startsWith('..')) return 'external';
  const hit = firstExisting([`${base}.rs`, `${base}/mod.rs`], ctx);
  if (hit) return { id: hit, missing: false };
  return { id: `${base}.rs`, missing: true };
}

// ── Go ─────────────────────────────────────────────────────────────────────

// A Go import names a directory, not a file. The graph's nodes are files, so
// one file has to stand for the package: the one named after the directory if
// it exists, otherwise the first non-test source in it.
//
// ponytail: this under-reports — importing a package really depends on every
// file in it. Emitting an edge per file would need a resolver that can return
// several targets; do that if package-level fan-out turns out to matter.
function packageFile(dir: string, ext: string, ctx: ResolveContext): string | undefined {
  const files = (ctx.listDir?.(dir) ?? []).filter(f => f.endsWith(ext) && !f.endsWith(`_test${ext}`));
  if (files.length === 0) return undefined;
  const name = dir.slice(dir.lastIndexOf('/') + 1);
  return files.find(f => f === `${dir}/${name}${ext}`) ?? [...files].sort()[0];
}

export function resolveGoImport(target: string, _fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const mod = ctx.goModule;
  // Without go.mod every import looks third-party; with it, only the repo's own
  // module prefix is a project file. "fmt" and "github.com/x/y" stay external.
  if (!mod || (target !== mod && !target.startsWith(`${mod}/`))) return 'external';
  const dir = target === mod ? '' : target.slice(mod.length + 1);
  const hit = packageFile(dir, '.go', ctx);
  if (hit) return { id: hit, missing: false };
  const name = dir.slice(dir.lastIndexOf('/') + 1) || 'main';
  return { id: dir ? `${dir}/${name}.go` : `${name}.go`, missing: true };
}

// ── PHP ────────────────────────────────────────────────────────────────────

export function resolvePhpUse(target: string, _fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const name = target.replace(/\\/g, '/');
  for (const base of expandAlias(name, ctx.psr4 ?? [])) {
    if (ctx.fileExists(`${base}.php`)) return { id: `${base}.php`, missing: false };
  }
  // No composer map, or a vendor class: not something we can point at on disk.
  return 'external';
}

// ── JVM ────────────────────────────────────────────────────────────────────

const JVM_ROOTS = ['src/main/java/', 'src/main/kotlin/', 'src/test/java/', 'src/test/kotlin/', 'src/', ''];

export function resolveJavaImport(target: string, _fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const rel = target.replace(/\./g, '/');
  const hit = firstExisting(
    JVM_ROOTS.flatMap(root => [`${root}${rel}.java`, `${root}${rel}.kt`]),
    ctx,
  );
  if (hit) return { id: hit, missing: false };
  // A nested class (a.b.Outer.Inner) lives in its outer class's file.
  const outer = dropLastSegment(rel);
  if (outer) {
    const nested = firstExisting(JVM_ROOTS.flatMap(root => [`${root}${outer}.java`, `${root}${outer}.kt`]), ctx);
    if (nested) return { id: nested, missing: false };
  }
  return 'external'; // the JDK, or a jar dependency
}

// ── C / C++ ────────────────────────────────────────────────────────────────

// Quoted includes are searched relative to the including file first — that is
// what the quotes mean — then in the include roots a project conventionally
// puts on the compiler's -I path. Angle-bracket includes never get here: the
// scanner marks them external.
const C_ROOTS = ['include/', 'src/', 'lib/', ''];

export function resolveCInclude(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const local = normalizeJoin(fromDir, target);
  if (!local.startsWith('..') && ctx.fileExists(local)) return { id: local, missing: false };
  const hit = firstExisting(C_ROOTS.map(root => `${root}${target}`), ctx);
  if (hit) return { id: hit, missing: false };
  return { id: local.startsWith('..') ? target : local, missing: true };
}

// ── Markdown ───────────────────────────────────────────────────────────────

export function resolveMarkdownLink(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const base = normalizeJoin(fromDir, target);
  if (base.startsWith('..')) return 'external';
  const hit = firstExisting([base, `${base}.md`, `${base}/README.md`, `${base}/index.md`], ctx);
  if (hit) return { id: hit, missing: false };
  // Only a link that spells a filename is a broken link; an extensionless one
  // is usually a site route the docs build generates, not a file we lost.
  return /\.\w+$/.test(base) ? { id: base, missing: true } : 'external';
}

// ── Shell / Terraform ──────────────────────────────────────────────────────

export function resolveShellSource(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const base = normalizeJoin(fromDir, target);
  if (base.startsWith('..')) return 'external';
  if (ctx.fileExists(base)) return { id: base, missing: false };
  const hit = firstExisting([`${base}.sh`, `scripts/${target}`], ctx);
  if (hit) return { id: hit, missing: false };
  return { id: base, missing: true };
}

export function resolveTerraformModule(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  const dir = normalizeJoin(fromDir, target);
  if (dir.startsWith('..')) return 'external';
  const main = `${dir}/main.tf`;
  if (ctx.fileExists(main)) return { id: main, missing: false };
  const hit = packageFile(dir, '.tf', ctx);
  if (hit) return { id: hit, missing: false };
  return { id: main, missing: true };
}

export const languageResolvers: RelResolver[] = [
  { rel: 'py_import', resolve: resolvePythonImport },
  { rel: 'rb_require', resolve: resolveRubyRequire },
  { rel: 'rb_require_relative', resolve: resolveRubyRequireRelative },
  { rel: 'rust_mod', resolve: resolveRustMod },
  { rel: 'go_import', resolve: resolveGoImport },
  { rel: 'php_use', resolve: resolvePhpUse },
  { rel: 'java_import', resolve: resolveJavaImport },
  { rel: 'c_include', resolve: resolveCInclude },
  { rel: 'md_link', resolve: resolveMarkdownLink },
  { rel: 'sh_source', resolve: resolveShellSource },
  { rel: 'tf_module', resolve: resolveTerraformModule },
];
