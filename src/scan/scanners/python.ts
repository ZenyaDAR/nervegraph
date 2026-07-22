import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { truncate } from './util.ts';

// Line-oriented, not an AST. Import statements in Python are required to be at
// statement level, so anchoring at line start (after indentation) is both what
// makes this cheap and what makes it accurate: a `#` comment or a string body
// almost never starts a line with `import `/`from `.
//
// ponytail: a module-level docstring containing a line that begins with
// "import x" will produce a phantom ref. Blanking triple-quoted strings first
// would fix it — do that if it ever shows up in a real project.

const IMPORT_RE = /^[ \t]*import[ \t]+(.+?)[ \t]*(?:#.*)?$/;
const FROM_RE = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(.+?)[ \t]*(?:#.*)?$/;

// `import a.b.c as x, d.e` -> ["a.b.c", "d.e"]
function splitImportList(list: string): string[] {
  return list
    .split(',')
    .map(part => part.trim().split(/[ \t]+as[ \t]+/)[0].trim())
    .filter(part => /^[.\w]+$/.test(part));
}

// `from pkg import (a, b)` -> ["a", "b"]; a submodule import is indistinguishable
// from a name import without resolving, so the resolver tries both.
function splitNameList(list: string): string[] {
  return list
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map(part => part.trim().split(/[ \t]+as[ \t]+/)[0].trim())
    .filter(part => /^\w+$/.test(part));
}

export function scanPython(file: { id: string; content: string }): ScannerResult {
  const refs: RawRef[] = [];
  const lines = file.content.split('\n');

  lines.forEach((text, i) => {
    const line = i + 1;

    const from = FROM_RE.exec(text);
    if (from) {
      const [, module, names] = from;
      const raw = truncate(text);
      if (names.trim() === '*') {
        refs.push({ rel: 'py_import', target: module, line, raw, literal: true });
        return;
      }
      // `from pkg import mod` may mean pkg/mod.py or a name defined in
      // pkg/__init__.py. Emit the submodule candidate — the resolver tries the
      // deeper path first and falls back to the package itself, so both cases
      // land on a real file. Several names from one package collapse to the
      // same edge; build.ts dedupes.
      const imported = splitNameList(names);
      if (imported.length === 0) {
        refs.push({ rel: 'py_import', target: module, line, raw, literal: true });
        return;
      }
      for (const n of imported) {
        const joined = module.endsWith('.') ? `${module}${n}` : `${module}.${n}`;
        refs.push({ rel: 'py_import', target: joined, line, raw, literal: true });
      }
      return;
    }

    const imp = IMPORT_RE.exec(text);
    if (imp) {
      for (const target of splitImportList(imp[1])) {
        refs.push({ rel: 'py_import', target, line, raw: truncate(text), literal: true });
      }
    }
  });

  return { refs };
}
