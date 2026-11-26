import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { parseJsonc } from '../aliases.ts';
import { inlineScripts } from './html.ts';
import { scanJavaScript } from './javascript.ts';
import { blank, customElementRefs, isExternalUrl, lineAt, sectionApiRefs } from './util.ts';

// Replace {% comment %}, {% doc %} and {% raw %} bodies with an equal number
// of newlines so line numbers stay correct, but the content itself (a doc
// block's `{% render 'x' %}` usage example, say) produces no matches. Inline
// `{% # … %}` comments and comments inside {% liquid %} go the same way.
export function stripCommentsAndRaw(content: string): string {
  return content
    .replace(/\{%-?\s*comment\b[^%]*%\}[\s\S]*?\{%-?\s*endcomment\b[^%]*%\}/g, m => '\n'.repeat(countNewlines(m)))
    .replace(/\{%-?\s*doc\s*-?%\}[\s\S]*?\{%-?\s*enddoc\s*-?%\}/g, m => '\n'.repeat(countNewlines(m)))
    .replace(/\{%-?\s*raw\s*-?%\}[\s\S]*?\{%-?\s*endraw\s*-?%\}/g, m => '\n'.repeat(countNewlines(m)))
    .replace(/\{%-?\s*#[\s\S]*?%\}/g, m => '\n'.repeat(countNewlines(m)))
    .replace(/(\{%-?\s*liquid\b)([\s\S]*?)(%\})/g, (_m, open: string, body: string, close: string) => open + body
      .replace(/^[ \t]*comment[ \t\r]*$[\s\S]*?^[ \t]*endcomment\b[^\n]*/gm, m => '\n'.repeat(countNewlines(m)))
      .replace(/^[ \t]*#[^\n]*/gm, '') + close);
}

function countNewlines(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === '\n') n++;
  return n;
}

function truncateRaw(s: string): string {
  const trimmed = s.trim();
  return trimmed.length > 120 ? trimmed.slice(0, 120) : trimmed;
}

const QUOTED = `'([^']*)'|"([^"]*)"`;

// Tag arguments up to the closing `%}`; a lone `%` (`width: '100%'`) is part of
// them. An unclosed tag ends at the next `{%` instead of swallowing it.
const ARGS = '((?:[^%{]|%(?!\\})|\\{(?!%))+?)';

/** `{% tag args %}`, whitespace control included; group 1 is the arguments. */
function tagRe(tag: string): RegExp {
  return new RegExp(`\\{%-?\\s*${tag}\\s+${ARGS}-?%\\}`, 'g');
}

// A literal piped straight into a file or translation filter, in any tag:
// `{{- 'a.css' | asset_url }}`, `{% assign u = 'a.js' | asset_url %}`. A literal
// after `:` or `,` is another filter's argument (`| append: '.svg' | asset_url`).
const FILTER_RE = /(?:\{\{-?\s*|(?<![:,]\s*))(?:'([^'\n{}]+)'|"([^"\n{}]+)")\s*\|\s*(asset_url|asset_img_url|inline_asset_content|t|translate)\b(?:[^{}%\n]*\}\})?/g;

const SCHEMA_RE = /\{%-?\s*schema\s*-?%\}([\s\S]*?)\{%-?\s*endschema\s*-?%\}/;

/**
 * Theme blocks a schema names in `blocks`, `presets` or `default`, and the block
 * types it defines itself. An entry with a name or settings is a local block
 * and has no file; a bare `{ "type": "slide" }` is blocks/slide.liquid.
 */
function schemaBlocks(content: string): { refs: RawRef[]; localBlocks: string[]; presets: boolean } {
  const m = SCHEMA_RE.exec(content);
  const schema = m && parseJsonc(m[1]);
  if (!m || !schema || typeof schema !== 'object') return { refs: [], localBlocks: [], presets: false };

  const items = (blocks: unknown): any[] =>
    blocks && typeof blocks === 'object' ? Object.values(blocks).filter(b => typeof b?.type === 'string') : [];
  const local = new Set<string>(
    items(schema.blocks).filter(b => b.name !== undefined || b.settings !== undefined).map(b => b.type));

  const types = new Set<string>();
  const collect = (blocks: unknown, top: boolean): void => {
    for (const b of items(blocks)) {
      const placeholder = b.type.startsWith('@') || b.type.startsWith('shopify://');
      if (!placeholder && !(top && local.has(b.type))) types.add(b.type);
      collect(b.blocks, false);
    }
  };
  collect(schema.blocks, true);
  for (const preset of Array.isArray(schema.presets) ? schema.presets : []) collect(preset?.blocks, true);
  collect(schema.default?.blocks, true);

  // Settings have a "type" too; searching from the first "blocks" key skips the section's own.
  const bodyStart = m.index + m[0].indexOf(m[1]);
  const from = bodyStart + Math.max(m[1].indexOf('"blocks"'), 0);
  const refs = [...types].map((type): RawRef => {
    const escaped = type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const at = new RegExp(`"type"\\s*:\\s*"${escaped}"`).exec(content.slice(from));
    return {
      rel: 'content_for', target: type, line: lineAt(content, from + (at?.index ?? 0)),
      raw: truncateRaw(`"type": "${type}"`), literal: true, value: 'schema_block',
    };
  });
  return { refs, localBlocks: [...local], presets: Array.isArray(schema.presets) && schema.presets.length > 0 };
}

const JAVASCRIPT_TAG_RE = /\{%-?\s*javascript\s*-?%\}([\s\S]*?)\{%-?\s*endjavascript\s*-?%\}/g;

/**
 * Inline `<script>` and `{% javascript %}` bodies: bare imports (import map
 * names) and custom elements. A relative import resolves against the page URL,
 * not this file, so it names no project file.
 */
function inlineJs(id: string, content: string): { refs: RawRef[]; defines: string[] } {
  const refs: RawRef[] = [];
  const defines: string[] = [];
  const bodies = inlineScripts(content.replace(/<!--[\s\S]*?-->/g, blank));
  for (const m of content.matchAll(JAVASCRIPT_TAG_RE)) {
    bodies.push({ body: m[1], offset: lineAt(content, m.index + m[0].indexOf(m[1])) - 1 });
  }
  for (const { body, offset } of bodies) {
    if (!/\bimport\b|customElements/.test(body)) continue;
    const js = scanJavaScript({ id, content: body });
    defines.push(...js.defines ?? []);
    for (const ref of js.refs) {
      const bare = (ref.rel === 'import' || ref.rel === 'dynamic_import') && ref.literal
        && /^[@#\w]/.test(ref.target) && !isExternalUrl(ref.target) && !/[{}]/.test(ref.target);
      if (bare) refs.push({ ...ref, line: ref.line + offset });
    }
  }
  return { refs, defines };
}

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
  const expression = new RegExp(`\\{%-?\\s*assign\\s+([A-Za-z_][\\w-]*)\\s*=\\s*${ARGS}-?%\\}`, 'g');
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
  const firstArgRe = new RegExp(`^(?:${QUOTED}|(\\S+))`);

  scanTag(tagRe('render'), 'render');
  scanTag(tagRe('include'), 'include');
  scanTag(tagRe('section'), 'section');
  scanTag(tagRe('sections'), 'section_group');
  scanTag(tagRe('content_for'), 'content_for');

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

  // `asset_url` is a name looked up by convention in assets/, not a path —
  // distinct from the `asset` rel that CSS url() and <img src> emit.
  for (const m of content.matchAll(FILTER_RE)) {
    const rel = m[3] === 't' || m[3] === 'translate' ? 'translation' : 'asset_url';
    const target = m[1] ?? m[2];
    // `'?' | asset_url` is a trick to get the assets base URL, not a file.
    if (!/[\p{L}\p{N}]/u.test(target)) continue;
    refs.push({ rel, target, line: lineAt(content, m.index), raw: truncateRaw(m[0]), literal: true });
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

  for (const ref of [...customElementRefs(content), ...sectionApiRefs(content)]) refs.push(ref);

  const schema = schemaBlocks(content);
  const js = inlineJs(file.id, content);
  refs.push(...schema.refs, ...js.refs);

  return { refs, defines: js.defines, localBlocks: schema.localBlocks, ...(schema.presets ? { presets: true } : {}) };
}
