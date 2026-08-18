import { init, parse } from 'es-module-lexer';
import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate } from './util.ts';

await init;

/**
 * Which bindings an import statement pulls in, so the graph can tell a used
 * export from a dead one. `['*']` means "unknowable — assume everything":
 * a namespace import, a re-export star, a require() or a dynamic import().
 * An empty list is a side-effect-only `import './x.js'`.
 */
export function importedNames(stmt: string): string[] {
  const m = /^\s*(?:import|export)\s+([\s\S]*?)\s+from\s/.exec(stmt);
  if (!m) return []; // `import './x.js'` — loaded for effect, binds nothing
  const clause = m[1];
  if (clause.includes('*')) return ['*'];

  const names: string[] = [];
  const brace = /\{([\s\S]*)\}/.exec(clause);
  const beforeBrace = clause.split('{')[0].replace(/,\s*$/, '').trim();
  // `import Thing from 'x'` binds the default export; `import type Thing` too,
  // but a bare `type` left over from `import type { A }` is not a binding.
  if (beforeBrace && beforeBrace !== 'type') names.push('default');
  if (brace) {
    for (const part of brace[1].split(',')) {
      const original = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
      if (original) names.push(original);
    }
  }
  return names;
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
      // A dynamic import()'s bindings are destructured later, out of the
      // statement — unknowable here, so it counts as "uses everything".
      const names = imp.d > -1 ? ['*'] : importedNames(raw);
      refs.push({ rel, target: imp.n, line, raw: truncate(raw), literal: true, names });
    }
    for (const e of exps) exports.push(e.n);
  } catch {
    usedLexer = false;
  }

  if (!usedLexer) {
    // Fallback regex pass. es-module-lexer is a JS lexer, so TSX generics and
    // some decorator syntax make it throw — and this branch used to catch only
    // `import()` and `require()`, silently dropping every static import in the
    // file. A .tsx component then looked like it depended on nothing.
    const staticRe = /\b(?:import|export)\b[\s\S]{0,400}?\bfrom\s*(?:'([^']+)'|"([^"]+)")|^\s*import\s*(?:'([^']+)'|"([^"]+)")/gm;
    const importRe = /\bimport\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*\)/g;
    const requireRe = /\brequire\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = staticRe.exec(content))) {
      const target = m[1] ?? m[2] ?? m[3] ?? m[4];
      refs.push({ rel: 'import', target, line: lineAt(content, m.index), raw: truncate(m[0]), literal: true, names: importedNames(m[0]) });
    }
    while ((m = importRe.exec(content))) {
      const target = m[1] ?? m[2];
      refs.push({ rel: 'dynamic_import', target, line: lineAt(content, m.index), raw: truncate(m[0]), literal: true, names: ['*'] });
    }
    while ((m = requireRe.exec(content))) {
      const target = m[1] ?? m[2];
      refs.push({ rel: 'require', target, line: lineAt(content, m.index), raw: truncate(m[0]), literal: true, names: ['*'] });
    }
    return { refs, defines: definedElements(content) };
  }

  // require() literal (CommonJS), regex-based, ignoring string/comment noise is
  // out of scope for a fallback pass on top of the lexer output.
  const requireRe = /\brequire\s*\(\s*(?:'([^']+)'|"([^"]+)")\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = requireRe.exec(content))) {
    const target = m[1] ?? m[2];
    refs.push({ rel: 'require', target, line: lineAt(content, m.index), raw: truncate(m[0]), literal: true, names: ['*'] });
  }

  return { refs, exports, defines: definedElements(content) };
}

// `customElements.define('product-form', …)` is how a modern theme wires
// markup to behaviour. Without it a <product-form> in a section looks like
// plain markup and the JS that runs it looks orphaned.
const DEFINE_RE = /customElements\s*\.\s*define\s*\(\s*(?:'([^']+)'|"([^"]+)")/g;

function definedElements(content: string): string[] {
  const names = [];
  let m;
  while ((m = DEFINE_RE.exec(content))) names.push(m[1] ?? m[2]);
  return names;
}
