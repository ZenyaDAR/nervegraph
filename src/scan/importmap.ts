import path from 'node:path';
import type { AliasRule } from './aliases.ts';
import type { ScannedFile } from './files.ts';
import { langFor } from './extensions.ts';
import { normalizeJoin } from '../graph/resolvers/path-utils.ts';
import { stripCommentsAndRaw } from './scanners/liquid.ts';
import { blank, isExternalUrl } from './scanners/util.ts';

// A `<script>` inside a Liquid string must not swallow the map after it.
const SCRIPT_RE = /<script\b([^>]*)>((?:(?!<script\b)[\s\S])*?)<\/script>/gi;
const IMPORT_MAP_TYPE_RE = /\btype\s*=\s*["']?importmap\b/i;
// Regex rather than JSON.parse: in a theme the body is a Liquid template.
// `"name": "{{ 'file.js' | asset_url }}"` or `"name": "./file.js"`.
const ENTRY_RE = /"([^"\n]+)"\s*:\s*(?:"?\{\{-?\s*['"]([^'"\n]+)['"]\s*\|\s*asset_url\b[^}]*\}\}"?|"([^"{}\n]*)")/g;

/**
 * `<script type="importmap">` entries as alias rules. Without them a theme's
 * `import … from '@theme/component'` looks like an npm package.
 * An HTML page's map applies to its own directory; a theme's to the whole theme.
 * shortcut: `scopes` and all the theme's maps are flattened into one; split per
 * page when a theme ships two maps that disagree.
 */
export function importMapAliases(files: ScannedFile[]): AliasRule[] {
  const rules: AliasRule[] = [];
  for (const file of files) {
    const lang = langFor(file.id);
    if ((lang !== 'liquid' && lang !== 'html') || !file.content.includes('importmap')) continue;
    const dir = path.posix.dirname(file.id);
    const scope = lang === 'html' && dir !== '.' ? { scope: dir } : {};
    const text = (lang === 'liquid' ? stripCommentsAndRaw(file.content) : file.content).replace(/<!--[\s\S]*?-->/g, blank);
    for (const [, attrs, body] of text.matchAll(SCRIPT_RE)) {
      if (!IMPORT_MAP_TYPE_RE.test(attrs)) continue;
      for (const [, name, asset, url] of body.matchAll(ENTRY_RE)) {
        const target = asset !== undefined ? `assets/${asset}` : urlTarget(url, file.id, lang === 'liquid');
        if (!target) continue;
        // A trailing slash maps a whole prefix.
        rules.push(name.endsWith('/')
          ? { prefix: `${name}*`, targets: [`${target.replace(/\/$/, '')}/*`], ...scope }
          : { prefix: name, targets: [target], ...scope });
      }
    }
  }
  return rules;
}

// A Liquid file's relative URL is relative to whatever page renders it, so it names no file.
function urlTarget(url: string, fileId: string, liquid: boolean): string | undefined {
  if (!url || isExternalUrl(url) || (liquid && !url.startsWith('/'))) return undefined;
  const target = normalizeJoin(path.posix.dirname(fileId), url.split(/[?#]/)[0]);
  return target.startsWith('..') ? undefined : target;
}
