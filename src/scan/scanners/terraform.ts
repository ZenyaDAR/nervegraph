import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate } from './util.ts';

// Terraform's file graph is `module "x" { source = "./modules/y" }`: a local
// source is a directory of .tf files, anything else (a registry name, a git
// URL) is external infrastructure we don't have on disk.

// Anchored at a line start so `module` inside a string or another block's
// attribute never opens a match; `source` is then looked up only inside that
// module's own braces, so a module without one can't borrow the next block's.
const MODULE_RE = /^[ \t]*module[ \t]+"[^"]+"[ \t]*\{/gm;
const SOURCE_RE = /^[ \t]*source[ \t]*=[ \t]*"([^"]+)"/m;
const COMMENT_RE = /^[ \t]*(?:#|\/\/).*$/gm;

/** The body between the `{` at `open` and its matching `}` (or the file end). */
function blockBody(content: string, open: number): string {
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}' && --depth === 0) return content.slice(open + 1, i);
  }
  return content.slice(open + 1);
}

export function scanTerraform(file: { id: string; content: string }): ScannerResult {
  const content = file.content.replace(COMMENT_RE, m => m.replace(/[^\n]/g, ' '));
  const refs: RawRef[] = [];

  for (const m of content.matchAll(MODULE_RE)) {
    const source = SOURCE_RE.exec(blockBody(content, m.index + m[0].length - 1));
    if (!source) continue;
    const target = source[1];
    const local = target.startsWith('./') || target.startsWith('../');
    refs.push({
      rel: 'tf_module',
      target,
      line: lineAt(content, m.index),
      raw: truncate(`module source = "${target}"`),
      literal: local,
      ...(local ? {} : { value: 'external' }),
    });
  }

  return { refs };
}
