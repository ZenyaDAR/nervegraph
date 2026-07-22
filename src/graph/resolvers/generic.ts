import type { RelResolver, ResolveContext, ResolvedTarget } from './types.ts';
import { normalizeJoin, stripMinSuffix } from './path-utils.ts';

const JS_EXT_CHAIN = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'];

// Node-style module resolution: bare specifiers ("lodash") are external;
// relative specifiers get the extension-chain / index fallback treatment.
// Used by any language whose refs are JS-module-shaped (import/require/dynamic
// import) — currently JavaScript/TypeScript, profile-agnostic.
export function resolveModule(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget {
  if (!target.startsWith('.') && !target.startsWith('/')) return 'external';
  const base = normalizeJoin(fromDir, target);
  if (base.startsWith('..')) return 'external';

  for (const ext of JS_EXT_CHAIN) {
    const candidate = base + ext;
    if (ctx.fileExists(candidate)) return { id: candidate, missing: false };
  }
  for (const idx of ['/index.ts', '/index.js']) {
    const candidate = base + idx;
    if (ctx.fileExists(candidate)) return { id: candidate, missing: false };
  }
  const original = stripMinSuffix(base);
  if (original && ctx.fileExists(original)) return { id: original, missing: false };
  // nothing found: missing node at the exact path (no extension guess)
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
  { rel: 'css_import', resolve: resolveDirRelative },
  { rel: 'script_src', resolve: resolveDirRelative },
  { rel: 'link_href', resolve: resolveDirRelative },
  // `asset` is always a path — a CSS url() or an <img src>. The Shopify
  // convention lookup ({{ 'x' | asset_url }} -> assets/x) is a separate rel,
  // `asset_url`, so a theme's own stylesheet can still say url("../img/x.png")
  // and resolve correctly.
  { rel: 'asset', resolve: resolveDirRelative },
];
