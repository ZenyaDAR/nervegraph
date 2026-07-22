import type { RelResolver, ResolveContext, ResolvedTarget } from './types.ts';
import { normalizeJoin } from './path-utils.ts';

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

export const languageResolvers: RelResolver[] = [
  { rel: 'py_import', resolve: resolvePythonImport },
  { rel: 'rb_require', resolve: resolveRubyRequire },
  { rel: 'rb_require_relative', resolve: resolveRubyRequireRelative },
  { rel: 'rust_mod', resolve: resolveRustMod },
];
