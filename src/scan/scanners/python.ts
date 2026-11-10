import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { truncate, blank } from './util.ts';

// Line-oriented, not an AST. Import statements in Python are required to be at
// statement level, so anchoring at line start (after indentation) is both what
// makes this cheap and what makes it accurate: a `#` comment or a string body
// almost never starts a line with `import `/`from `. Triple-quoted strings are
// the exception (a docstring showing usage), so they are blanked first.

const IMPORT_RE = /^[ \t]*import[ \t]+(.+?)[ \t]*(?:#.*)?$/;
const FROM_RE = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import[ \t]+(.+?)[ \t]*(?:#.*)?$/;
const TRIPLE_QUOTED_RE = /"""[\s\S]*?"""|'''[\s\S]*?'''/g;

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
  const lines = file.content.replace(TRIPLE_QUOTED_RE, blank).split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = i + 1;
    let text = lines[i];

    // `from pkg import (\n  a,\n  b,\n)`: join the continuation lines so the
    // whole name list is matched as one statement, reported at its first line.
    if (/^[ \t]*from[ \t]+[.\w]+[ \t]+import[ \t]*\([^)]*$/.test(text.replace(/#.*$/, ''))) {
      let j = i;
      let joined = text.replace(/#.*$/, '');
      while (j + 1 < lines.length && !joined.includes(')')) {
        j++;
        joined += ' ' + lines[j].replace(/#.*$/, '').trim();
      }
      text = joined;
      i = j;
    }

    const from = FROM_RE.exec(text);
    if (from) {
      const [, module, names] = from;
      const raw = truncate(text);
      if (names.trim() === '*') {
        refs.push({ rel: 'py_import', target: module, line, raw, literal: true });
        continue;
      }
      // `from pkg import mod` may mean pkg/mod.py or a name defined in
      // pkg/__init__.py. Emit the submodule candidate — the resolver tries the
      // deeper path first and falls back to the package itself, so both cases
      // land on a real file. Several names from one package collapse to the
      // same edge; build.ts dedupes.
      const imported = splitNameList(names);
      if (imported.length === 0) {
        refs.push({ rel: 'py_import', target: module, line, raw, literal: true });
        continue;
      }
      for (const n of imported) {
        const joined = module.endsWith('.') ? `${module}${n}` : `${module}.${n}`;
        refs.push({ rel: 'py_import', target: joined, line, raw, literal: true });
      }
      continue;
    }

    const imp = IMPORT_RE.exec(text);
    if (imp) {
      for (const target of splitImportList(imp[1])) {
        refs.push({ rel: 'py_import', target, line, raw: truncate(text), literal: true });
      }
    }
  }

  return { refs };
}
