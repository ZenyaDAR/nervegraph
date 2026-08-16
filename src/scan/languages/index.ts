import type { LanguageModule, LanguageContext } from './types.ts';
import { langFor, type Lang } from '../extensions.ts';
import { shopifyJsonLanguage } from './shopify-json.ts';
import { scanLiquid } from '../scanners/liquid.ts';
import { scanJavaScript } from '../scanners/javascript.ts';
import { scanHtml } from '../scanners/html.ts';
import { scanCss } from '../scanners/css.ts';
import { scanPython } from '../scanners/python.ts';
import { scanRuby } from '../scanners/ruby.ts';
import { scanRust } from '../scanners/rust.ts';
import { scanComponent } from '../scanners/component.ts';
import { scanGo } from '../scanners/go.ts';
import { scanPhp } from '../scanners/php.ts';
import { scanJvm } from '../scanners/jvm.ts';
import { scanClang } from '../scanners/clang.ts';
import { scanMarkdown } from '../scanners/markdown.ts';
import { scanShell } from '../scanners/shell.ts';
import { scanTerraform } from '../scanners/terraform.ts';
import type { Scanner } from '../../graph/types.ts';

/**
 * Most languages claim exactly the files whose extension maps to their `Lang`
 * in extensions.ts, so the module is fully described by (id, langs, scanner).
 * A language needing more than that — a profile check, a directory rule —
 * gets its own file instead (see shopify-json.ts).
 */
function byLang(id: string, langs: Lang[], scan: Scanner): LanguageModule {
  const set = new Set(langs);
  return { id, matches: (fileId) => set.has(langFor(fileId)), scan: (file) => scan(file) };
}

// Adding a new language: write scanners/<lang>.ts (pure string -> RawRef[],
// see EXTENDING.md), add its extensions to scan/extensions.ts, and add a row
// here. If it introduces new RelTypes, register their resolution in
// graph/resolvers/. Nothing else in build.ts or resolve.ts needs to change.
//
// Order matters only where two modules could claim the same file:
// shopify-json must precede anything that would claim plain .json.
const LANGUAGES: LanguageModule[] = [
  byLang('liquid', ['liquid'], scanLiquid),
  shopifyJsonLanguage,
  byLang('javascript', ['javascript', 'typescript'], scanJavaScript),
  byLang('html', ['html'], scanHtml),
  byLang('css', ['css'], scanCss),
  byLang('python', ['python'], scanPython),
  byLang('ruby', ['ruby'], scanRuby),
  byLang('rust', ['rust'], scanRust),
  byLang('component', ['vue', 'svelte', 'astro'], scanComponent),
  byLang('go', ['go'], scanGo),
  byLang('php', ['php'], scanPhp),
  byLang('jvm', ['java', 'kotlin'], scanJvm),
  byLang('clang', ['c', 'cpp'], scanClang),
  byLang('markdown', ['markdown'], scanMarkdown),
  byLang('shell', ['shell'], scanShell),
  byLang('terraform', ['hcl'], scanTerraform),
];

export type { LanguageModule, LanguageContext } from './types.ts';

export function findLanguage(fileId: string, ctx: LanguageContext): LanguageModule | undefined {
  return LANGUAGES.find(l => l.matches(fileId, ctx));
}
