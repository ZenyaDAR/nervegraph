import type { RelResolver, ResolveContext, ResolvedTarget } from './types.ts';
import { stripMinSuffix } from './path-utils.ts';

// Shopify theme conventions: a Liquid tag name is looked up at a fixed path
// by naming convention alone (no traversal, no extension chain) — see
// These only apply under the shopify profile;
// resolvers/generic.ts covers the profile-agnostic code-level rels (import,
// css_import, ...) that a theme's own assets/*.js and assets/*.css still use.
function structural(candidate: string, ctx: ResolveContext): ResolvedTarget {
  if (ctx.fileExists(candidate)) return { id: candidate, missing: false };
  const original = stripMinSuffix(candidate);
  if (original && ctx.fileExists(original)) return { id: original, missing: false };
  return { id: candidate, missing: true };
}

// assets/x.css.liquid is served — and referenced — as `x.css`.
function asset(target: string, ctx: ResolveContext): ResolvedTarget {
  const plain = structural(`assets/${target}`, ctx);
  if (plain !== 'external' && plain.missing && ctx.fileExists(`assets/${target}.liquid`)) {
    return { id: `assets/${target}.liquid`, missing: false };
  }
  return plain;
}

// "apps" wraps top-level app blocks. Shopify looks for apps.liquid, then
// _blocks.liquid, then falls back to a wrapper of its own.
function templateSection(target: string, ctx: ResolveContext): ResolvedTarget {
  const own = structural(`sections/${target}.liquid`, ctx);
  if (target !== 'apps' || own === 'external' || !own.missing) return own;
  return ctx.fileExists('sections/_blocks.liquid') ? { id: 'sections/_blocks.liquid', missing: false } : 'external';
}

export const shopifyResolvers: RelResolver[] = [
  { rel: 'render', profiles: ['shopify'], resolve: (target, _fromDir, ctx) => structural(`snippets/${target}.liquid`, ctx) },
  { rel: 'include', profiles: ['shopify'], resolve: (target, _fromDir, ctx) => structural(`snippets/${target}.liquid`, ctx) },
  { rel: 'section', profiles: ['shopify'], resolve: (target, _fromDir, ctx) => structural(`sections/${target}.liquid`, ctx) },
  { rel: 'template_section', profiles: ['shopify'], resolve: (target, _fromDir, ctx) => templateSection(target, ctx) },
  { rel: 'section_group', profiles: ['shopify'], resolve: (target, _fromDir, ctx) => structural(`sections/${target}.json`, ctx) },
  { rel: 'content_for', profiles: ['shopify'], resolve: (target, _fromDir, ctx) => structural(`blocks/${target}.liquid`, ctx) },
  { rel: 'asset_url', profiles: ['shopify'], resolve: (target, _fromDir, ctx) => asset(target, ctx) },
  { rel: 'translation', profiles: ['shopify'], resolve: (_target, _fromDir, ctx) => structural(ctx.defaultLocale ?? 'locales/en.default.json', ctx) },
];
