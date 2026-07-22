import type { RawRef, ScannerResult } from '../../graph/types.ts';

// Replace {% comment %}...{% endcomment %} and {% raw %}...{% endraw %} bodies
// with an equal number of newlines so line numbers stay correct, but the
// content itself produces no matches.
function stripCommentsAndRaw(content: string): string {
  return content
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, m => '\n'.repeat(countNewlines(m)))
    .replace(/\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g, m => '\n'.repeat(countNewlines(m)));
}

function countNewlines(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === '\n') n++;
  return n;
}

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (content[i] === '\n') line++;
  return line;
}

function truncateRaw(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

const QUOTED = `'([^']*)'|"([^"]*)"`;

export function scanLiquid(file: { id: string; content: string }): ScannerResult {
  const refs: RawRef[] = [];
  const content = stripCommentsAndRaw(file.content);

  function pushTagRefs(tagRe: RegExp, rel: RawRef['rel'], argPattern: RegExp) {
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(content))) {
      const full = m[0];
      const line = lineAt(content, m.index);
      const argMatch = argPattern.exec(full);
      handleArg(argMatch, full, line, rel);
    }
  }

  function handleArg(argMatch: RegExpExecArray | null, full: string, line: number, rel: RawRef['rel']) {
    if (!argMatch) return;
    const isConcatenated = /\|\s*append/.test(full) || /\|\s*prepend/.test(full);
    const quoted = argMatch[1] ?? argMatch[2];
    if (quoted !== undefined && !isConcatenated) {
      refs.push({ rel, target: quoted, line, raw: truncateRaw(full), literal: true });
      return;
    }
    // not a plain literal: dynamic or concatenated
    const rawArg = argMatch[0];
    refs.push({
      rel,
      target: rawArg,
      line,
      raw: truncateRaw(full),
      literal: false,
      value: isConcatenated ? 'concatenated' : 'dynamic',
    });
  }

  // {% render 'name' ... %} / {% include 'name' ... %}
  const renderRe = /\{%-?\s*render\s+([^%]+?)-?%\}/g;
  const includeRe = /\{%-?\s*include\s+([^%]+?)-?%\}/g;
  const sectionRe = /\{%-?\s*section\s+([^%]+?)-?%\}/g;
  const sectionsRe = /\{%-?\s*sections\s+([^%]+?)-?%\}/g;
  const contentForRe = /\{%-?\s*content_for\s+([^%]+?)-?%\}/g;

  const firstArgRe = new RegExp(`^(?:${QUOTED}|(\\S+))`);

  scanTag(renderRe, 'render');
  scanTag(includeRe, 'include');
  scanTag(sectionRe, 'section');
  scanTag(sectionsRe, 'section_group');
  scanTag(contentForRe, 'content_for');

  function scanTag(re: RegExp, rel: RawRef['rel']) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const full = m[0];
      const args = m[1].trim();
      const line = lineAt(content, m.index);
      const argMatch = firstArgRe.exec(args);
      handleArg(argMatch, full, line, rel);
    }
  }

  // {{ 'file.js' | asset_url }} / asset_img_url
  const assetRe = new RegExp(`\\{\\{\\s*(?:${QUOTED})\\s*\\|\\s*asset(?:_img)?_url[^}]*\\}\\}`, 'g');
  {
    let m: RegExpExecArray | null;
    while ((m = assetRe.exec(content))) {
      const target = m[1] ?? m[2];
      const line = lineAt(content, m.index);
      // `asset_url` is a name looked up by convention in assets/, not a path —
      // distinct from the `asset` rel that CSS url() and <img src> emit.
      refs.push({ rel: 'asset_url', target, line, raw: truncateRaw(m[0]), literal: true });
    }
  }

  // {{ 'key.sub' | t }}
  const tRe = new RegExp(`\\{\\{\\s*(?:${QUOTED})\\s*\\|\\s*t(?:\\s*:[^}]*)?\\s*\\}\\}`, 'g');
  {
    let m: RegExpExecArray | null;
    while ((m = tRe.exec(content))) {
      const target = m[1] ?? m[2];
      const line = lineAt(content, m.index);
      refs.push({ rel: 'translation', target, line, raw: truncateRaw(m[0]), literal: true });
    }
  }

  // {% liquid ... %} block: lines starting with render/include/section
  const liquidBlockRe = /\{%-?\s*liquid\s+([\s\S]*?)-?%\}/g;
  {
    let m: RegExpExecArray | null;
    while ((m = liquidBlockRe.exec(content))) {
      const blockStart = m.index + m[0].indexOf(m[1]);
      const lines = m[1].split('\n');
      let offset = 0;
      for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        const tagMatch = /^(render|include|section|sections|content_for)\s+(.+)$/.exec(trimmed);
        if (tagMatch) {
          const rel = (tagMatch[1] === 'sections' ? 'section_group' : tagMatch[1]) as RawRef['rel'];
          const argMatch = firstArgRe.exec(tagMatch[2].trim());
          const lineNo = lineAt(content, blockStart + offset);
          handleArg(argMatch, trimmed, lineNo, rel);
        }
        offset += rawLine.length + 1;
      }
    }
  }

  // <script src="..."> / <link href="...">
  scanHtmlAttr(/<script[^>]+src=(?:"([^"{}]+)"|'([^'{}]+)')[^>]*>/g, 'script_src');
  scanHtmlAttr(/<link[^>]+href=(?:"([^"{}]+)"|'([^'{}]+)')[^>]*>/g, 'link_href');

  function scanHtmlAttr(re: RegExp, rel: RawRef['rel']) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const target = m[1] ?? m[2];
      const line = lineAt(content, m.index);
      if (/^(https?:)?\/\//.test(target)) {
        refs.push({ rel, target, line, raw: truncateRaw(m[0]), literal: false, value: 'external' });
        continue;
      }
      if (!target.startsWith('.') && !target.startsWith('/')) continue;
      refs.push({ rel, target, line, raw: truncateRaw(m[0]), literal: true });
    }
  }

  return { refs };
}
