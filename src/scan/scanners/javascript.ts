import { init, parse } from 'es-module-lexer';
import type { RawRef, ScannerResult } from '../../graph/types.ts';

await init;

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}

function truncate(s: string): string {
  const t = s.trim();
  return t.length > 120 ? t.slice(0, 120) : t;
}

function classify(target: string): 'import' | 'dynamic_import' {
  return target ? 'import' : 'import';
}

export function scanJavaScript(file: { id: string; content: string }): ScannerResult {
  const refs: RawRef[] = [];
  const exports: string[] = [];
  const content = file.content;

  let usedLexer = true;
  try {
    const [imports, exps] = parse(content);
    for (const imp of imports) {
      if (!imp.n) {
        // dynamic import() with non-literal expression, or import.meta
        if (imp.d > -1) {
          const raw = content.slice(imp.ss, imp.se);
          refs.push({ rel: 'dynamic_import', target: raw, line: lineAt(content, imp.s), raw: truncate(raw), literal: false, value: 'dynamic' });
        }
        continue;
      }
      const raw = content.slice(imp.ss, imp.se);
      const line = lineAt(content, imp.s);
      const rel = imp.d > -1 ? 'dynamic_import' : 'import';
      refs.push({ rel, target: imp.n, line, raw: truncate(raw), literal: true });
    }
    for (const e of exps) exports.push(e.n);
  } catch {
    usedLexer = false;
  }

  if (!usedLexer) {
    // Fallback regex pass for non-module scripts, imports/require in strings only.
    const importRe = /\bimport\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*\)/g;
    const requireRe = /\brequire\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content))) {
      const target = m[1] ?? m[2];
      refs.push({ rel: 'dynamic_import', target, line: lineAt(content, m.index), raw: truncate(m[0]), literal: true });
    }
    while ((m = requireRe.exec(content))) {
      const target = m[1] ?? m[2];
      refs.push({ rel: 'require', target, line: lineAt(content, m.index), raw: truncate(m[0]), literal: true });
    }
    return { refs };
  }

  // require() literal (CommonJS), regex-based, ignoring string/comment noise is
  // out of scope for a fallback pass on top of the lexer output.
  const requireRe = /\brequire\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = requireRe.exec(content))) {
    const target = m[1] ?? m[2];
    refs.push({ rel: 'require', target, line: lineAt(content, m.index), raw: truncate(m[0]), literal: true });
  }

  return { refs, exports };
}
