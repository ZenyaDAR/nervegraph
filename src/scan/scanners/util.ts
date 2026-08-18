import type { RawRef } from '../../graph/types.ts';

// Helpers every scanner needs. These were copy-pasted into each scanner
// before there were more than three of them.

const RAW_MAX = 120;

/** 1-based line number of a character offset. */
export function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}

/** The `raw` field of a RawRef: trimmed, capped so graph.json stays small. */
export function truncate(s: string): string {
  const t = s.trim();
  return t.length > RAW_MAX ? t.slice(0, RAW_MAX) : t;
}

/**
 * Replace every non-newline character of `m` with a space, preserving length
 * and line breaks. Lets a scanner blank out comments/strings before matching
 * without shifting any offset, so `lineAt` stays correct.
 */
export function blank(m: string): string {
  return m.replace(/[^\n]/g, ' ');
}

/** A URL that points outside the project: http(s), protocol-relative, data:, mailto:, #anchor. */
export function isExternalUrl(target: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target);
}

// A tag name with a dash is a custom element by spec — the markup half of a
// web component. Paired with customElements.define() in build.ts, it turns
// "markup here, behaviour over there" into a real edge.
// The delimiter class is what keeps a longer tag name from matching a shorter
// one; a closing `</…>` never matches at all.
const CUSTOM_ELEMENT_RE = /<([a-z][a-z0-9]*-[a-z0-9-]*)(?=[\s/>])/g;

export function customElementRefs(content: string): RawRef[] {
  const refs: RawRef[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  CUSTOM_ELEMENT_RE.lastIndex = 0;
  while ((m = CUSTOM_ELEMENT_RE.exec(content))) {
    const tag = m[1];
    if (seen.has(tag)) continue; // one edge per element, not one per usage
    seen.add(tag);
    refs.push({ rel: 'custom_element', target: tag, line: lineAt(content, m.index), raw: `<${tag}>`, literal: true });
  }
  return refs;
}
