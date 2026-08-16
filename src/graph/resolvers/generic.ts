import type { RelResolver, ResolveContext, ResolvedTarget } from './types.ts';
import { normalizeJoin, stripMinSuffix } from './path-utils.ts';
import { expandAlias } from '../../scan/aliases.ts';

const JS_EXT_CHAIN = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte', '.astro', '.json'];
const JS_INDEX_CHAIN = ['/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.mjs'];

/** The extension-chain / directory-index lookup, shared by path and alias resolution. */
function jsCandidate(base: string, ctx: ResolveContext): string | undefined {
  for (const ext of JS_EXT_CHAIN) {
    if (ctx.fileExists(base + ext)) return base + ext;
  }
  for (const idx of JS_INDEX_CHAIN) {
    if (ctx.fileExists(base + idx)) return base + idx;
  }
  const original = stripMinSuffix(base);
  if (original && ctx.fileExists(original)) return original;
  return undefined;
}

// Node-style module resolution: relative specifiers get the extension-chain /
// index fallback treatment; a bare specifier is tried against the project's
// alias rules (tsconfig `paths`/`baseUrl`, package.json `imports`, workspace
// package names) and only then reported external as an npm package.
// Used by any language whose refs are JS-module-shaped (import/require/dynamic
// import) — currently JavaScript/TypeScript, profile-agnostic.
export function resolveModule(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  if (!target.startsWith('.') && !target.startsWith('/')) {
    for (const candidate of expandAlias(target, ctx.aliases ?? [])) {
      const hit = jsCandidate(candidate, ctx);
      if (hit) return { id: hit, missing: false };
    }
    // An alias that matched no file is still more likely a package than a
    // broken import (baseUrl makes *every* bare specifier match a rule), so
    // this stays external rather than inventing a missing node.
    return 'external';
  }
  const base = normalizeJoin(fromDir, target);
  if (base.startsWith('..')) return 'external';

  const hit = jsCandidate(base, ctx);
  if (hit) return { id: hit, missing: false };
  // nothing found: missing node at the exact path (no extension guess)
  return { id: base, missing: true };
}

// Sass resolves "base" to _base.scss, base.scss, or base/_index.scss, and
// `@use`/`@forward` never spell the extension. Plain CSS `@import` still works
// through the first (exact) candidate.
const STYLE_EXT = ['.scss', '.sass', '.css', '.less'];

export function resolveStyleImport(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  if (/^(https?:)?\/\//.test(target)) return 'external';
  const base = normalizeJoin(fromDir, target);
  if (base.startsWith('..')) return 'external';

  const slash = base.lastIndexOf('/');
  const dir = slash >= 0 ? base.slice(0, slash + 1) : '';
  const name = slash >= 0 ? base.slice(slash + 1) : base;

  const candidates = [base];
  for (const ext of STYLE_EXT) {
    candidates.push(`${base}${ext}`, `${dir}_${name}${ext}`, `${base}/_index${ext}`, `${base}/index${ext}`);
  }
  const hit = candidates.find(c => ctx.fileExists(c));
  if (hit) return { id: hit, missing: false };
  const original = stripMinSuffix(base);
  if (original && ctx.fileExists(original)) return { id: original, missing: false };
  return { id: base, missing: true };
}

// Same-directory-by-default resolution: "base.css" from assets/theme.css means
// assets/base.css — no leading './' required, unlike JS module specifiers.
// Used for CSS @import/@use, <script src>, <link href>, and CSS url().
export function resolveDirRelative(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  if (/^(https?:)?\/\//.test(target)) return 'external';
  const joined = normalizeJoin(fromDir, target);
  if (joined.startsWith('..')) return 'external';
  if (ctx.fileExists(joined)) return { id: joined, missing: false };
  const original = stripMinSuffix(joined);
  if (original && ctx.fileExists(original)) return { id: original, missing: false };
  return { id: joined, missing: true };
}

// Rels whose resolution is "how does this file reach a sibling file", the
// same regardless of project profile — a JS file's own imports don't care
// whether the surrounding project is a Shopify theme or a plain JS project.
export const genericResolvers: RelResolver[] = [
  { rel: 'import', resolve: resolveModule },
  { rel: 'require', resolve: resolveModule },
  { rel: 'dynamic_import', resolve: resolveModule },
  { rel: 'css_import', resolve: resolveStyleImport },
  { rel: 'script_src', resolve: resolveDirRelative },
  { rel: 'link_href', resolve: resolveDirRelative },
  // `asset` is always a path — a CSS url() or an <img src>. The Shopify
  // convention lookup ({{ 'x' | asset_url }} -> assets/x) is a separate rel,
  // `asset_url`, so a theme's own stylesheet can still say url("../img/x.png")
  // and resolve correctly.
  { rel: 'asset', resolve: resolveDirRelative },
];
