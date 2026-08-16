import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate, blank, isExternalUrl } from './util.ts';

// Docs are part of a codebase's dependency structure — a README pointing at
// three guides that point at each other is a graph, and a doc nobody links to
// is an orphan the same way an unused snippet is. Links to source files
// (`see [the resolver](../src/graph/resolve.ts)`) tie the two together.

const FENCE_RE = /^([ \t]*)(```|~~~)[\s\S]*?^\1\2[ \t]*$/gm;
const INLINE_CODE_RE = /`[^`\n]*`/g;
// [text](target "title") and ![alt](target); the target stops at whitespace.
const LINK_RE = /(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
// [id]: target "title" — reference-style definitions, at line start.
const REF_DEF_RE = /^[ \t]{0,3}\[[^\]]+\]:[ \t]*<?([^\s>]+)>?/gm;

export function scanMarkdown(file: { id: string; content: string }): ScannerResult {
  // Blank code first: a fenced example is documentation of a link, not a link.
  const content = file.content
    .replace(FENCE_RE, blank)
    .replace(INLINE_CODE_RE, blank);

  const refs: RawRef[] = [];

  function push(target: string, index: number, raw: string, isImage: boolean) {
    // A bare "#section" is an in-page anchor, not a reference to a file.
    if (target.startsWith('#')) return;
    const clean = target.split('#')[0];
    if (!clean) return;
    const rel = isImage ? 'asset' : 'md_link';
    const line = lineAt(content, index);
    if (isExternalUrl(clean)) {
      refs.push({ rel, target: clean, line, raw: truncate(raw), literal: false, value: 'external' });
      return;
    }
    refs.push({ rel, target: clean, line, raw: truncate(raw), literal: true });
  }

  for (const m of content.matchAll(LINK_RE)) push(m[2], m.index, m[0], m[1] === '!');
  for (const m of content.matchAll(REF_DEF_RE)) push(m[1], m.index, m[0], false);

  return { refs };
}
