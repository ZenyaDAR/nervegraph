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
