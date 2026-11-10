import postcss from 'postcss';
import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { truncate, blank } from './util.ts';

const CLASS_RE = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;
const SCSS_TOKEN_RE = /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|url\([^)]*\)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

// `font.woff2?v=3#iefix` -> `font.woff2`; a bare `#id` names no file at all.
function cleanUrl(target: string): string {
  return target.split(/[?#]/)[0];
}

export function scanCss(file: { id: string; content: string }): ScannerResult {
  const refs: RawRef[] = [];
  const classes = new Set<string>();

  // postcss rejects SCSS/Less `//` line comments outright, which cost such a
  // file all of its refs. Blank them (keeping offsets) while leaving strings,
  // url(...) and /* */ bodies alone, so `url(http://x)` survives.
  const source = /\.(?:scss|less)$/i.test(file.id)
    ? file.content.replace(SCSS_TOKEN_RE, m => (m.startsWith('//') ? blank(m) : m))
    : file.content;

  let root;
  try {
    root = postcss.parse(source, { from: undefined });
  } catch {
    throw new Error('invalid css');
  }

  root.walkAtRules(/^(import|use|forward)$/, (atRule) => {
    const raw = `@${atRule.name} ${atRule.params}`;
    const line = atRule.source?.start?.line ?? 0;
    const urlMatch = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(atRule.params);
    // Sass `@import 'a', 'b';` lists several files; `@use`/`@forward` one.
    const strings = [...atRule.params.matchAll(/['"]([^'"]+)['"]/g)].map(m => m[1]);
    const targets = urlMatch ? [urlMatch[1]] : atRule.name === 'import' ? strings : strings.slice(0, 1);
    for (const found of targets) {
      // `@use 'sass:math'` is a built-in module, not a file.
      if (found.startsWith('sass:')) continue;
      if (/^(https?:)?\/\//.test(found)) {
        refs.push({ rel: 'css_import', target: found, line, raw: truncate(raw), literal: false, value: 'external' });
        continue;
      }
      const target = cleanUrl(found);
      if (!target) continue;
      refs.push({ rel: 'css_import', target, line, raw: truncate(raw), literal: true });
    }
  });

  root.walkDecls((decl) => {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(decl.value))) {
      const line = decl.source?.start?.line ?? 0;
      if (m[2].startsWith('data:')) continue;
      if (/^(https?:)?\/\//.test(m[2])) {
        refs.push({ rel: 'asset', target: m[2], line, raw: truncate(decl.toString()), literal: false, value: 'external' });
        continue;
      }
      // `url(#gradient)` points into an SVG document, not at a file.
      const target = cleanUrl(m[2]);
      if (!target) continue;
      refs.push({ rel: 'asset', target, line, raw: truncate(decl.toString()), literal: true });
    }
  });

  root.walkRules((rule) => {
    if (rule.selector) {
      let m: RegExpExecArray | null;
      const re = new RegExp(CLASS_RE);
      while ((m = re.exec(rule.selector))) {
        classes.add(m[1]);
      }
    }
  });

  return { refs, classes: Array.from(classes) };
}
