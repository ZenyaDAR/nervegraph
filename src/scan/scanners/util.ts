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

// After one of these characters (or keywords) a `/` starts a regex literal,
// anywhere else it is division. The classic heuristic; good enough to keep a
// `/'/` regex from opening a fake string that swallows the rest of the line.
const REGEX_PREFIX_CHARS = new Set('(,=:[!&|?{};+-*%<>~^');
const REGEX_PREFIX_WORDS = /\b(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * JS/TS source with comments blanked and the *contents* of string and
 * template literals blanked, quotes kept. Same length and line breaks as the
 * input, so a regex can run over the mask and read the real string back from
 * the original at the same offsets — `require('x')` inside a comment or a
 * string no longer becomes an edge.
 */
export function maskJs(src: string): string {
  const out = src.split('');
  const n = src.length;
  const blankRange = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let prev = ''; // last significant character outside comments/strings
  let prevWordEnd = 0;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? n : end;
      blankRange(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      blankRange(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n' && c !== '`') break; // unterminated: stop at the line end
        j++;
      }
      blankRange(i + 1, Math.min(j, n));
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_PREFIX_CHARS.has(prev) || REGEX_PREFIX_WORDS.test(src.slice(Math.max(0, prevWordEnd - 8), prevWordEnd)) && prevWordEnd === lastNonSpace(src, i))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      blankRange(i + 1, j);
      i = j + 1;
      prev = '/';
      continue;
    }
    if (!/\s/.test(c)) {
      prev = c;
      if (/[\w$]/.test(c)) prevWordEnd = i + 1;
    }
    i++;
  }
  return out.join('');
}

/** Offset just past the last non-whitespace character before `i`. */
function lastNonSpace(src: string, i: number): number {
  let k = i - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  return k + 1;
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
