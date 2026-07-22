import path from 'node:path';

// Single source of truth for "what language is this file". Three consumers
// used to each keep their own extension list and drift apart: scan/files.ts
// (what to read as text), scan/profile.ts (node type), graph/build.ts (node
// lang label). Adding a language means adding rows here, not hunting them down.

export type Lang =
  | 'javascript' | 'typescript' | 'html' | 'css' | 'liquid'
  | 'python' | 'ruby' | 'rust' | 'json'
  | 'svg' | 'image' | 'other';

// Extensions whose contents we parse. Anything here is read into memory and
// handed to a LanguageModule (if one claims it); everything else is a leaf.
export const SOURCE_EXT: Record<string, Lang> = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'css', '.sass': 'css', '.less': 'css',
  '.liquid': 'liquid',
  '.py': 'python', '.pyi': 'python',
  '.rb': 'ruby', '.rake': 'ruby', '.gemspec': 'ruby',
  '.rs': 'rust',
  '.json': 'json',
};

// Binary/opaque leaves: they can be edge *targets* (a CSS url(), a Shopify
// asset_url) so they become nodes, but they're never read or parsed.
const ASSET_EXT: Record<string, Lang> = {
  '.svg': 'svg',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.avif': 'image',
};

export const TEXT_EXT = new Set(Object.keys(SOURCE_EXT));

export function extOf(id: string): string {
  return path.extname(id).toLowerCase();
}

export function langFor(id: string): Lang {
  const ext = extOf(id);
  return SOURCE_EXT[ext] ?? ASSET_EXT[ext] ?? 'other';
}

// JS and TS share a scanner, a node type, and a resolver — they differ only in
// the `lang` label shown in the viewer. This is the "is it JS-family" test.
export function isScriptLang(lang: Lang): boolean {
  return lang === 'javascript' || lang === 'typescript';
}
