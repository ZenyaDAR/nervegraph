import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate, blank } from './util.ts';

// Java and Kotlin share one scanner: both spell an import as a dotted,
// package-qualified type name at statement level, and both map packages onto
// directories under a source root. Kotlin's `import a.b.c as d` and Java's
// `import static a.b.C.m` are the only syntactic extras.
//
// ponytail: same-package references need no import, so they produce no edge —
// a Java graph shows cross-package coupling only. Fixing that means resolving
// bare type names against the package directory, which needs a real parser.

const IMPORT_RE = /^[ \t]*import[ \t]+(?:static[ \t]+)?([\w.]+)/gm;
const LINE_COMMENT_RE = /\/\/.*$/gm;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

export function scanJvm(file: { id: string; content: string }): ScannerResult {
  const content = file.content
    .replace(BLOCK_COMMENT_RE, blank)
    .replace(LINE_COMMENT_RE, blank);

  const refs: RawRef[] = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const target = m[1];
    // `import a.b.*` names a package, not a file; the resolver would have to
    // pick one of its types arbitrarily, so it is left out entirely. (The
    // capture stops before the star, so the trailing dot is what's left.)
    if (target.endsWith('.')) continue;
    refs.push({ rel: 'java_import', target, line: lineAt(content, m.index), raw: truncate(m[0]), literal: true });
  }
  return { refs };
}
