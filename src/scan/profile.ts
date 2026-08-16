import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NodeType } from '../graph/types.ts';
import { langFor, type Lang } from './extensions.ts';

export type Profile = 'shopify' | 'js' | 'poly';

export const PROFILES: Profile[] = ['shopify', 'js', 'poly'];

// Manifest files that identify a non-JS ecosystem. A repo with one of these
// and no package.json used to be scanned as "js" with a "no known project
// type" warning, which was both noisy and wrong — nothing about a Cargo
// workspace is a JavaScript project.
const POLY_MARKERS = [
  'Cargo.toml', 'go.mod', 'pyproject.toml', 'setup.py', 'requirements.txt',
  'Gemfile', 'composer.json', 'CMakeLists.txt', 'Makefile',
  'pom.xml', 'build.gradle', 'build.gradle.kts',
];

export function detectProfile(root: string, forced?: string): { profile: Profile; warning?: string } {
  if (PROFILES.includes(forced as Profile)) return { profile: forced as Profile };
  const hasSettingsSchema = existsSync(path.join(root, 'config/settings_schema.json'));
  const hasShopifyDirs = existsSync(path.join(root, 'sections')) &&
    existsSync(path.join(root, 'snippets')) &&
    existsSync(path.join(root, 'layout/theme.liquid'));
  if (hasSettingsSchema || hasShopifyDirs) return { profile: 'shopify' };
  if (existsSync(path.join(root, 'package.json'))) return { profile: 'js' };
  if (POLY_MARKERS.some(m => existsSync(path.join(root, m)))) return { profile: 'poly' };
  return { profile: 'poly', warning: 'no project manifest found, scanning with the generic profile' };
}

// Ordered rule tables, first match wins — directory convention takes
// priority over extension. Adding a new shopify-like directory convention or
// a new profile is a matter of adding one row, not touching the function body.
const SHOPIFY_RULES: [RegExp, NodeType][] = [
  [/^layout\/.*\.liquid$/, 'layout'],
  [/^templates\/.*\.json$/, 'template_json'],
  [/^templates\/.*\.liquid$/, 'template'],
  [/^sections\/.*\.json$/, 'section_group'],
  [/^sections\/.*\.liquid$/, 'section'],
  [/^snippets\/.*\.liquid$/, 'snippet'],
  [/^blocks\/.*\.liquid$/, 'block'],
];

// Every language that has a node type of its own. JS and TS deliberately share
// one — the distinction is carried by the node's `lang`, and giving TypeScript
// a separate color would split one concern across two hues in the viewer.
const LANG_NODE_TYPE: Partial<Record<Lang, NodeType>> = {
  javascript: 'javascript',
  typescript: 'javascript',
  html: 'html',
  css: 'css',
  python: 'python',
  ruby: 'ruby',
  rust: 'rust',
  json: 'json',
};

export function classifyNodeType(id: string, profile: Profile): NodeType {
  // Directory conventions win over extension: sections/foo.liquid is a
  // `section`, not a generic liquid file.
  if (profile === 'shopify') {
    for (const [pattern, type] of SHOPIFY_RULES) if (pattern.test(id)) return type;
  }

  const lang = langFor(id);
  const byLang = LANG_NODE_TYPE[lang];
  if (byLang) return byLang;

  // Images and vectors are assets wherever they live; other unrecognised
  // files only count as assets under an assets/ directory convention.
  if (lang === 'svg' || lang === 'image') return 'asset';
  if (/^assets\//.test(id)) return 'asset';
  return 'unknown';
}

export function isEntrypoint(id: string, profile: Profile, pkg?: any): boolean {
  if (profile === 'shopify') {
    return /^layout\/.*\.liquid$/.test(id) ||
      /^templates\/.*\.(liquid|json)$/.test(id) ||
      id === 'config/settings_schema.json' ||
      /^locales\/.*\.json$/.test(id);
  }
  if (pkg) {
    for (const key of ['main', 'module', 'bin']) {
      const v = pkg[key];
      if (typeof v === 'string' && normalize(v) === id) return true;
      if (v && typeof v === 'object') {
        for (const bv of Object.values(v)) {
          if (typeof bv === 'string' && normalize(bv) === id) return true;
        }
      }
    }
    if (pkg.exports) {
      const exp = pkg.exports;
      const vals = typeof exp === 'string' ? [exp] : Object.values(flattenExports(exp));
      for (const v of vals) if (typeof v === 'string' && normalize(v) === id) return true;
    }
  }
  return GENERIC_ENTRYPOINTS.some(re => re.test(id));
}

// Files a project is entered *through*, so nothing imports them and they'd
// otherwise be flagged as orphans. Conventional names only — a heuristic that
// guessed wider would mark half a Rails app as an entrypoint.
const GENERIC_ENTRYPOINTS: RegExp[] = [
  // JS / TS
  /^(src\/)?(index|main)\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/,
  // HTML — the page the browser loads
  /^(src\/|public\/)?index\.html?$/,
  // Rust — crate roots and binary targets
  /^(src\/)?(main|lib)\.rs$/,
  /^src\/bin\/[^/]+\.rs$/,
  // Python — scripts and package mains
  /^(src\/)?(main|app|manage|setup|wsgi|asgi)\.py$/,
  /^(.*\/)?__main__\.py$/,
  // Ruby — Rails boot files and test harnesses
  /^config\/(application|environment|routes|boot)\.rb$/,
  /^(spec\/spec_helper|test\/test_helper)\.rb$/,
];

function flattenExports(exp: any): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(v: any, k: string) {
    if (typeof v === 'string') out[k] = v;
    else if (v && typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, `${k}.${kk}`);
  }
  walk(exp, 'exports');
  return out;
}

function normalize(p: string): string {
  return p.replace(/^\.\//, '').split(path.sep).join('/');
}
