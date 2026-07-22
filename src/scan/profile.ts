import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NodeType } from '../graph/types.ts';

export type Profile = 'shopify' | 'js';

export function detectProfile(root: string, forced?: string): { profile: Profile; warning?: string } {
  if (forced === 'shopify' || forced === 'js') return { profile: forced };
  const hasSettingsSchema = existsSync(path.join(root, 'config/settings_schema.json'));
  const hasShopifyDirs = existsSync(path.join(root, 'sections')) &&
    existsSync(path.join(root, 'snippets')) &&
    existsSync(path.join(root, 'layout/theme.liquid'));
  if (hasSettingsSchema || hasShopifyDirs) return { profile: 'shopify' };
  if (existsSync(path.join(root, 'package.json'))) return { profile: 'js' };
  return { profile: 'js', warning: 'no known project type, falling back to js profile' };
}

const JS_EXT = ['.js', '.mjs', '.ts', '.jsx', '.tsx'];
const CSS_EXT = ['.css', '.scss'];

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

export function classifyNodeType(id: string, profile: Profile): NodeType {
  const ext = path.extname(id).toLowerCase();

  if (profile === 'shopify') {
    for (const [pattern, type] of SHOPIFY_RULES) if (pattern.test(id)) return type;
    if (JS_EXT.includes(ext)) return 'javascript';
    if (CSS_EXT.includes(ext)) return 'css';
    if (/^assets\//.test(id)) return 'asset';
    if (ext === '.json') return 'json';
    return 'unknown';
  }

  // js profile
  if (JS_EXT.includes(ext)) return /^assets\//.test(id) ? 'javascript' : 'module';
  if (CSS_EXT.includes(ext)) return 'css';
  if (/^assets\//.test(id)) return 'asset';
  if (ext === '.json') return 'json';
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
  if (/^src\/(index|main)\.(ts|tsx|js|jsx|mjs)$/.test(id)) return true;
  if (/^index\.(ts|tsx|js|jsx|mjs)$/.test(id)) return true;
  return false;
}

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
