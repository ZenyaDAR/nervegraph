import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate, blank } from './util.ts';

// Go imports are always quoted string literals, in one of two forms:
//   import "fmt"
//   import ( _ "embed"\n  alias "example.com/m/pkg" )
// An import names a *package* (a directory), not a file — resolvers/languages.ts
// turns the module-qualified path into a directory and picks the file that
// represents it.

const SINGLE_RE = /^[ \t]*import[ \t]+(?:[\w.]+[ \t]+)?"([^"]+)"/gm;
const BLOCK_RE = /^[ \t]*import[ \t]*\(([\s\S]*?)^[ \t]*\)/gm;
const BLOCK_LINE_RE = /^[ \t]*(?:[\w.]+[ \t]+)?"([^"]+)"/gm;
const LINE_COMMENT_RE = /\/\/.*$/gm;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

export function scanGo(file: { id: string; content: string }): ScannerResult {
  const content = file.content
    .replace(BLOCK_COMMENT_RE, blank)
    .replace(LINE_COMMENT_RE, blank);

  const refs: RawRef[] = [];

  for (const m of content.matchAll(SINGLE_RE)) {
    refs.push({ rel: 'go_import', target: m[1], line: lineAt(content, m.index), raw: truncate(m[0]), literal: true });
  }

  for (const block of content.matchAll(BLOCK_RE)) {
    const body = block[1];
    const offset = lineAt(content, block.index + block[0].indexOf(body)) - 1;
    for (const m of body.matchAll(BLOCK_LINE_RE)) {
      refs.push({ rel: 'go_import', target: m[1], line: lineAt(body, m.index) + offset, raw: truncate(m[0]), literal: true });
    }
  }

  return { refs };
}
