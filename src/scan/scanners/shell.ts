import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate } from './util.ts';

// `source x.sh` / `. x.sh` is the only file-level dependency shell has. A path
// containing a variable ($DIR/lib.sh) is reported as dynamic rather than
// guessed — the common `. "$(dirname "$0")/lib.sh"` idiom would otherwise turn
// into a nonsense node id.

const SOURCE_RE = /^[ \t]*(?:source|\.)[ \t]+(['"]?)([^'"\n;&|]+)\1/gm;
const COMMENT_RE = /^[ \t]*#.*$/gm;

export function scanShell(file: { id: string; content: string }): ScannerResult {
  const content = file.content.replace(COMMENT_RE, m => m.replace(/[^\n]/g, ' '));
  const refs: RawRef[] = [];

  for (const m of content.matchAll(SOURCE_RE)) {
    const target = m[2].trim();
    if (!target) continue;
    const dynamic = /[$`*?]/.test(target);
    refs.push({
      rel: 'sh_source',
      target,
      line: lineAt(content, m.index),
      raw: truncate(m[0]),
      literal: !dynamic,
      ...(dynamic ? { value: 'dynamic' } : {}),
    });
  }

  return { refs };
}
