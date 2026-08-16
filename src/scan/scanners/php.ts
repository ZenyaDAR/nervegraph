import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate, blank } from './util.ts';

// Two very different reference kinds live in PHP, and conflating them would
// produce wrong edges:
//   require/include 'path.php'  — a literal path, resolved like any other path
//   use App\Models\User;        — a class name, resolved through composer.json's
//                                 PSR-4 autoload map (App\ -> src/)
// Anything built from an expression (`require __DIR__ . '/x.php'`) does not
// match the quoted form, so it is simply not reported rather than guessed at.

const REQUIRE_RE = /\b(?:require|include)(?:_once)?\s*\(?\s*(['"])([^'"\n]+)\1/g;
const USE_RE = /^[ \t]*use[ \t]+(?:function[ \t]+|const[ \t]+)?\\?([A-Za-z_][\w\\]*)/gm;
const LINE_COMMENT_RE = /(?:\/\/|#).*$/gm;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;

export function scanPhp(file: { id: string; content: string }): ScannerResult {
  const content = file.content
    .replace(BLOCK_COMMENT_RE, blank)
    .replace(LINE_COMMENT_RE, blank);

  const refs: RawRef[] = [];

  for (const m of content.matchAll(REQUIRE_RE)) {
    refs.push({ rel: 'php_require', target: m[2], line: lineAt(content, m.index), raw: truncate(m[0]), literal: true });
  }

  for (const m of content.matchAll(USE_RE)) {
    // A grouped use (`use App\{A, B};`) leaves a trailing brace on the name —
    // skip it rather than emitting a class that does not exist.
    const name = m[1];
    if (name.endsWith('\\')) continue;
    refs.push({ rel: 'php_use', target: name, line: lineAt(content, m.index), raw: truncate(m[0]), literal: true });
  }

  return { refs };
}
