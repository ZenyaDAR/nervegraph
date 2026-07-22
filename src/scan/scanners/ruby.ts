import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate, blank } from './util.ts';

// `require`/`require_relative` are ordinary method calls, so a regex over the
// source is the honest tool — there's no declaration syntax to parse.
//
// ponytail: Rails' autoloading (const `User` -> app/models/user.rb) is not
// require-based and produces no refs here, so a Rails app's file graph is
// thinner than its real coupling. Resolving it needs Zeitwerk's inflection
// rules; add a rails profile if that becomes the main use case.

const REQUIRE_RE = /\b(require_relative|require)\s*\(?\s*(['"])([^'"\n]+)\2/g;
const COMMENT_RE = /^[ \t]*#.*$/gm;
const HEREDOC_OR_BLOCK_COMMENT_RE = /^=begin[\s\S]*?^=end$/gm;

export function scanRuby(file: { id: string; content: string }): ScannerResult {
  // Blank comments (keeping offsets) so commented-out requires are ignored.
  const content = file.content
    .replace(HEREDOC_OR_BLOCK_COMMENT_RE, blank)
    .replace(COMMENT_RE, blank);

  const refs: RawRef[] = [];
  let m: RegExpExecArray | null;
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(content))) {
    const [full, kind, , target] = m;
    // A require built from an expression (File.join, __dir__ + ...) never
    // matches the quoted form above, so anything we get here is a literal.
    refs.push({
      rel: kind === 'require_relative' ? 'rb_require_relative' : 'rb_require',
      target,
      line: lineAt(content, m.index),
      raw: truncate(full),
      literal: true,
    });
  }

  return { refs };
}
