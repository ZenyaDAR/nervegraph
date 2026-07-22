import postcss from 'postcss';
import type { RawRef, ScannerResult } from '../../graph/types.ts';

function truncate(s: string): string {
  const t = s.trim();
  return t.length > 120 ? t.slice(0, 120) : t;
}

const CLASS_RE = /\.([a-zA-Z_-][a-zA-Z0-9_-]*)/g;

export function scanCss(file: { id: string; content: string }): ScannerResult {
  const refs: RawRef[] = [];
  const classes = new Set<string>();

  let root;
  try {
    root = postcss.parse(file.content, { from: undefined });
  } catch {
    throw new Error('invalid css');
  }

  root.walkAtRules(/^(import|use)$/, (atRule) => {
    const raw = `@${atRule.name} ${atRule.params}`;
    const line = atRule.source?.start?.line ?? 0;
    const urlMatch = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(atRule.params);
    const strMatch = /['"]([^'"]+)['"]/.exec(atRule.params);
    const target = urlMatch?.[1] ?? strMatch?.[1];
    if (!target) return;
    if (/^(https?:)?\/\//.test(target)) {
      refs.push({ rel: 'css_import', target, line, raw: truncate(raw), literal: false, value: 'external' });
      return;
    }
    refs.push({ rel: 'css_import', target, line, raw: truncate(raw), literal: true });
  });

  root.walkDecls((decl) => {
    const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(decl.value))) {
      const target = m[2];
      const line = decl.source?.start?.line ?? 0;
      if (target.startsWith('data:')) continue;
      if (/^(https?:)?\/\//.test(target)) {
        refs.push({ rel: 'asset', target, line, raw: truncate(decl.toString()), literal: false, value: 'external' });
        continue;
      }
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
