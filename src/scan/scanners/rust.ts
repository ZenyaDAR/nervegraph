import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate, blank } from './util.ts';

// In Rust the *file* graph is exactly the `mod foo;` declarations: they are
// what pulls another file into the crate. `use` paths are item-level imports
// within an already-included module tree, so they add no file edges that the
// `mod` graph doesn't already have — resolving them properly would need full
// name resolution (aliases, re-exports, glob imports) for no new nodes.
//
// ponytail: `#[path = "..."]` overrides and `mod foo { ... }` with an inline
// body are deliberately not followed; the trailing `;` in the regex is what
// distinguishes a file-backed module from an inline one.

// Leading attributes on the same line (`#[cfg(test)] mod tests;`) are allowed;
// group 1 keeps them so a `#[path = ...]` override can be skipped.
const MOD_RE = /^[ \t]*((?:#\[[^\]\n]*\][ \t]*)*)(?:pub(?:\s*\([^)]*\))?[ \t]+)?mod[ \t]+([A-Za-z_]\w*)[ \t]*;/gm;
// Strings and char literals are matched (and kept) so that a "/*" or "//"
// inside one is not mistaken for the start of a comment.
const CODE_TOKEN_RE = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\.|[^'\\\n])'|\/\*[\s\S]*?\*\/|\/\/.*$/gm;

// Where `mod foo;` looks for foo, expressed relative to the declaring file's
// own directory. A crate root (lib.rs/main.rs, build.rs, each src/bin/*.rs)
// and a directory module (mod.rs) own their directory, so `mod foo;` there
// means ./foo. Any other file a.rs owns the subdirectory a/, so `mod foo;` in
// a.rs means ./a/foo.
function modPrefix(fileId: string): string {
  const stem = fileId.slice(fileId.lastIndexOf('/') + 1).replace(/\.rs$/, '');
  const crateRoot = stem === 'build' || /(?:^|\/)src\/bin\/[^/]+\.rs$/.test(fileId);
  return crateRoot || stem === 'mod' || stem === 'lib' || stem === 'main' ? '' : `${stem}/`;
}

export function scanRust(file: { id: string; content: string }): ScannerResult {
  const content = file.content.replace(CODE_TOKEN_RE, m => (m.startsWith('/') ? blank(m) : m));

  const prefix = modPrefix(file.id);
  const refs: RawRef[] = [];
  let m: RegExpExecArray | null;
  MOD_RE.lastIndex = 0;
  while ((m = MOD_RE.exec(content))) {
    if (/#\[\s*path\b/.test(m[1])) continue;
    refs.push({
      rel: 'rust_mod',
      target: `${prefix}${m[2]}`,
      line: lineAt(content, m.index),
      raw: truncate(m[0]),
      literal: true,
    });
  }

  return { refs };
}
