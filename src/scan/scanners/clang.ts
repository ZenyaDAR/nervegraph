import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate, blank } from './util.ts';

// C and C++ have the simplest include graph of any language here, and the
// quoting distinguishes the two cases for us:
//   #include "local.h"  — a project file, resolved relative to the file and
//                         the usual include roots
//   #include <vector>   — the system/toolchain path, never a project file
// `#include MACRO` is not a literal and is skipped.

const INCLUDE_RE = /^[ \t]*#[ \t]*include[ \t]*(?:"([^"\n]+)"|<([^>\n]+)>)/gm;
const LINE_COMMENT_RE = /\/\/.*$/gm;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

export function scanClang(file: { id: string; content: string }): ScannerResult {
  const content = file.content
    .replace(BLOCK_COMMENT_RE, blank)
    .replace(LINE_COMMENT_RE, blank);

  const refs: RawRef[] = [];
  for (const m of content.matchAll(INCLUDE_RE)) {
    const angled = m[2] !== undefined;
    const target = m[1] ?? m[2];
    refs.push({
      rel: 'c_include',
      target,
      line: lineAt(content, m.index),
      raw: truncate(m[0]),
      literal: !angled,
      ...(angled ? { value: 'external' } : {}),
    });
  }
  return { refs };
}
