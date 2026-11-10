import { init, parse } from 'es-module-lexer';
import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, maskJs, truncate } from './util.ts';

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
    for (const e of exps) {
      if (!isLexerGarbage(content, e)) exports.push(e.n);
    }
  } catch {
    usedLexer = false;
  }

  // Comments and string contents blanked, quotes kept: every regex below runs
  // on this, so a `require('x')` in a comment or a string is not an edge.
  const masked = maskJs(content);
  const literalRefs = (re: RegExp, rel: RawRef['rel'], names: (raw: string) => string[]) => {
    for (const { index, target, raw } of literalMatches(content, masked, re)) {
      refs.push({ rel, target, line: lineAt(content, index), raw: truncate(raw), literal: true, names: names(raw) });
    }
  };

  if (!usedLexer) {
    // Fallback regex pass. es-module-lexer is a JS lexer, so TSX generics and
    // some decorator syntax make it throw — and this branch used to catch only
    // `import()` and `require()`, silently dropping every static import in the
    // file. A .tsx component then looked like it depended on nothing.
    literalRefs(/\b(?:import|export)\b[\s\S]{0,400}?\bfrom\s*('[^'\n]*'|"[^"\n]*")|^\s*import\s*('[^'\n]*'|"[^"\n]*")/dgm, 'import', importedNames);
    literalRefs(/\bimport\s*\(\s*('[^'\n]*'|"[^"\n]*")\s*\)/dg, 'dynamic_import', () => ['*']);
    literalRefs(REQUIRE_RE, 'require', () => ['*']);
    return { refs, defines: definedElements(content, masked) };
  }

  // es-module-lexer skips `export type { X } from` and `export type * from`
  // entirely, so the edge to the re-exported module was lost.
  literalRefs(/\bexport\s+type\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*('[^'\n]*'|"[^"\n]*")/dg, 'import', importedNames);
  literalRefs(REQUIRE_RE, 'require', () => ['*']);

  return { refs, exports: tsExportNames(masked, exports), defines: definedElements(content, masked) };
}

/** `require('x')`; group 1 is the quoted literal. */
const REQUIRE_RE = /\brequire\s*\(\s*('[^'\n]*'|"[^"\n]*")\s*\)/dg;

/**
 * Run `re` (with the `d` flag; group 1, or the first group that matched, is a
 * quoted string literal) over the masked source, and read each literal's real
 * text back from the original at the same offsets.
 */
function literalMatches(content: string, masked: string, re: RegExp): { index: number; target: string; raw: string }[] {
  const out: { index: number; target: string; raw: string }[] = [];
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const span = m.indices?.slice(1).find(Boolean);
    if (!span) continue;
    const target = content.slice(span[0] + 1, span[1] - 1);
    if (!target) continue;
    out.push({ index: m.index, target, raw: content.slice(m.index, m.index + m[0].length) });
  }
  return out;
}

// TS-only keywords es-module-lexer mistakes for export names:
// `export declare const D` -> "declare", `export const enum E` -> "enum".
const TS_EXPORT_KEYWORDS = new Set(['declare', 'abstract', 'enum', 'type', 'interface', 'namespace', 'module']);

/**
 * es-module-lexer is a JS lexer: on TS declarations it reports keywords or a
 * slice of one (`export abstract class Abs` -> "s"). Those are dropped here;
 * the real names come from tsExportNames().
 */
function isLexerGarbage(content: string, e: { n: string; s: number; e: number }): boolean {
  if (TS_EXPORT_KEYWORDS.has(e.n)) return true;
  const before = e.s > 0 ? content[e.s - 1] : '';
  const after = content[e.e] ?? '';
  return /[\w$]/.test(before) || /[\w$]/.test(after);
}

const TS_DECL_RE = /^[ \t]*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const\s+enum|function\s*\*?|class|enum|interface|type|namespace|module|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
const TS_TYPE_LIST_RE = /\bexport\s+type\s*\{([^}]*)\}/g;

/**
 * Lexer names plus the declarations it misses or misnames: TS `type`,
 * `interface`, `enum`, `namespace`, `declare …`, `abstract class`, and
 * `export type { A, B as C }`. Runs on the masked source, so commented-out
 * exports don't count. In plain JS this only re-finds what the lexer found.
 */
function tsExportNames(masked: string, lexerNames: string[]): string[] {
  const names = new Set(lexerNames);
  for (const m of masked.matchAll(TS_DECL_RE)) names.add(m[1]);
  for (const m of masked.matchAll(TS_TYPE_LIST_RE)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  if (/^[ \t]*export\s+default\b/m.test(masked)) names.add('default');
  return [...names];
}

// `customElements.define('product-form', …)` is how a modern theme wires
// markup to behaviour. Without it a <product-form> in a section looks like
// plain markup and the JS that runs it looks orphaned.
const DEFINE_RE = /customElements\s*\.\s*define\s*\(\s*('[^'\n]*'|"[^"\n]*")/dg;

function definedElements(content: string, masked: string): string[] {
  return literalMatches(content, masked, DEFINE_RE).map(m => m.target);
}
