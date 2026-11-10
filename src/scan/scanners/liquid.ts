import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { customElementRefs } from './util.ts';

// Replace {% comment %}, {% doc %} and {% raw %} bodies with an equal number
// of newlines so line numbers stay correct, but the content itself (a doc
// block's `{% render 'x' %}` usage example, say) produces no matches.
function stripCommentsAndRaw(content: string): string {
  return content
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, m => '\n'.repeat(countNewlines(m)))
    .replace(/\{%-?\s*doc\s*-?%\}[\s\S]*?\{%-?\s*enddoc\s*-?%\}/g, m => '\n'.repeat(countNewlines(m)))
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

/**
 * `{% assign card = 'product-card' %}` … `{% render card %}` — the indirection
 * costs nothing to follow when the value is a plain literal assigned exactly
 * once in the file. A name assigned twice, or from an expression, stays
 * unresolved: guessing which branch won is how false edges get made.
 */
function literalAssignments(content: string): Map<string, string> {
  const found = new Map<string, string>();
  const ambiguous = new Set<string>();
  const re = /\{%-?\s*assign\s+([A-Za-z_][\w-]*)\s*=\s*(?:'([^']*)'|"([^"]*)")\s*-?%\}/g;
  const expression = /\{%-?\s*assign\s+([A-Za-z_][\w-]*)\s*=\s*([^%]+?)-?%\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const name = m[1], value = m[2] ?? m[3];
    if (found.has(name) && found.get(name) !== value) ambiguous.add(name);
    else found.set(name, value);
  }
  // An assignment from anything other than a bare literal (a filter chain, a
  // variable, an object) makes the name unsafe even if it is also assigned a
  // literal elsewhere.
  while ((m = expression.exec(content))) {
    const rhs = m[2].trim();
    if (!/^(?:'[^']*'|"[^"]*")$/.test(rhs)) ambiguous.add(m[1]);
  }
  for (const name of ambiguous) found.delete(name);
  return found;
}

export function scanLiquid(file: { id: string; content: string }): ScannerResult {
  const refs: RawRef[] = [];
  const content = stripCommentsAndRaw(file.content);
  const assigned = literalAssignments(content);

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
    // A bare variable whose literal value the file itself set earlier.
    const rawArg = argMatch[0];
    if (!isConcatenated && quoted === undefined) {
      const value = assigned.get(rawArg.trim());
      if (value !== undefined) {
        refs.push({ rel, target: value, line, raw: truncateRaw(full), literal: true, value: 'assigned' });
        return;
      }
    }
    // not a plain literal: dynamic or concatenated
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
      if (rel === 'content_for') {
        handleContentFor(args, full, line);
        continue;
      }
      const argMatch = firstArgRe.exec(args);
      handleArg(argMatch, full, line, rel);
    }
  }

  // `{% content_for 'blocks' %}` renders whichever blocks the merchant added —
  // it names no file. `{% content_for 'block', type: 'slide', id: 'x' %}`
  // renders one static theme block, blocks/slide.liquid: the file is the
  // `type`, not the first argument.
  function handleContentFor(args: string, full: string, line: number) {
    const kind = firstArgRe.exec(args);
    const name = kind?.[1] ?? kind?.[2];
    if (name === 'blocks') return;
    if (name !== 'block') {
      handleArg(kind, full, line, 'content_for');
      return;
    }
    const type = /\btype\s*:\s*/.exec(args);
    if (!type) return;
    const value = args.slice(type.index + type[0].length).split(',')[0].trim();
    handleArg(firstArgRe.exec(value), full, line, 'content_for');
  }

  // `echo 'x' | asset_url` / `assign u = 'x' | asset_url` inside {% liquid %}.
  const liquidAssetRe = new RegExp(`^(?:echo|assign\\s+[\\w-]+\\s*=)\\s*(?:${QUOTED})\\s*\\|\\s*asset(?:_img)?_url\\b`);

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
        const lineNo = lineAt(content, blockStart + offset);
        if (tagMatch) {
          const rel = (tagMatch[1] === 'sections' ? 'section_group' : tagMatch[1]) as RawRef['rel'];
          if (rel === 'content_for') {
            handleContentFor(tagMatch[2].trim(), trimmed, lineNo);
          } else {
            const argMatch = firstArgRe.exec(tagMatch[2].trim());
            handleArg(argMatch, trimmed, lineNo, rel);
          }
        }
        const asset = liquidAssetRe.exec(trimmed);
        if (asset) {
          refs.push({ rel: 'asset_url', target: asset[1] ?? asset[2], line: lineNo, raw: truncateRaw(trimmed), literal: true });
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

  refs.push(...customElementRefs(content));

  return { refs };
}
