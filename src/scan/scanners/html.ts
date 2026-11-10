import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate, blank, isExternalUrl, customElementRefs } from './util.ts';
import { scanJavaScript } from './javascript.ts';

// Regex over tags, not a full HTML parser — same trade-off as the Liquid
// scanner (see README "Key decisions"). Reference attributes are trivially
// regular; a tolerant DOM parser would be a dependency for no extra edges.

const COMMENT_RE = /<!--[\s\S]*?-->/g;

// Tag -> which attribute carries the reference, and what relation it is.
const TAG_RULES: { tag: RegExp; attr: 'src' | 'href'; rel: RawRef['rel'] }[] = [
  { tag: /script/i, attr: 'src', rel: 'script_src' },
  { tag: /link/i, attr: 'href', rel: 'link_href' },
  { tag: /img|source|iframe|video|audio|embed|track|object/i, attr: 'src', rel: 'asset' },
];

const TAG_RE = /<(script|link|img|source|iframe|video|audio|embed|track|object)\b([^>]*)>/gi;
const CLASS_ATTR_RE = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

function attrValue(attrs: string, name: 'src' | 'href'): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? m[3];
}

export function scanHtml(file: { id: string; content: string }): ScannerResult {
  // Blank comments so commented-out markup produces no edges, keeping offsets
  // intact so line numbers stay honest.
  const content = file.content.replace(COMMENT_RE, blank);
  const refs: RawRef[] = [];
  const classes = new Set<string>();

  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(content))) {
    const [full, tagName, attrs] = m;
    const rule = TAG_RULES.find(r => r.tag.test(tagName));
    if (!rule) continue;
    const target = attrValue(attrs, rule.attr);
    const line = lineAt(content, m.index);

    if (target !== undefined && target !== '') {
      if (isExternalUrl(target)) {
        refs.push({ rel: rule.rel, target, line, raw: truncate(full), literal: false, value: 'external' });
      } else if (/\{\{|\{%|\$\{/.test(target)) {
        // Templating expression left in the attribute (Liquid, Handlebars, a JS
        // template literal) — the real path is only known at render time.
        // ponytail: an ERB `<%= %>` attribute is not seen at all, because the
        // `>` in `%>` terminates the tag match above. Blanking ERB tags first
        // would fix it; .html.erb isn't a scanned extension, so it hasn't come up.
        refs.push({ rel: rule.rel, target, line, raw: truncate(full), literal: false, value: 'dynamic' });
      } else {
        // `app.js?v=12` / `sprite.svg#icon` name the file before the suffix;
        // `href="/"` is the site root, not a file.
        const clean = target.split(/[?#]/)[0];
        if (clean && clean !== '/') {
          refs.push({ rel: rule.rel, target: clean, line, raw: truncate(full), literal: true });
        }
      }
    }
  }

  // class="..." feeds the optional --classes cross-reference against CSS.
  CLASS_ATTR_RE.lastIndex = 0;
  while ((m = CLASS_ATTR_RE.exec(content))) {
    const value = m[1] ?? m[2] ?? '';
    for (const c of value.split(/\s+/)) {
      if (c && !/[{}%$<]/.test(c)) classes.add(c);
    }
  }

  refs.push(...customElementRefs(content));

  return { refs, classes: Array.from(classes) };
}

const INLINE_SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const JS_TYPE_RE = /\btype\s*=\s*["']?(?:module|(?:text|application)\/(?:java|ecma)script)["']?/i;

/**
 * A standalone .html page: the markup refs plus imports from inline
 * `<script type="module">` (and classic inline scripts, whose `import()` is
 * just as real). Kept apart from scanHtml because single-file components
 * reuse scanHtml for their markup and scan their own <script> bodies.
 */
export function scanHtmlPage(file: { id: string; content: string }): ScannerResult {
  const result = scanHtml(file);
  const content = file.content.replace(COMMENT_RE, blank);
  for (const m of content.matchAll(INLINE_SCRIPT_RE)) {
    const attrs = m[1];
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/\btype\s*=/i.test(attrs) && !JS_TYPE_RE.test(attrs)) continue; // JSON, templates, ...
    const offset = lineAt(content, m.index + m[0].indexOf('>') + 1) - 1;
    for (const ref of scanJavaScript({ id: file.id, content: m[2] }).refs) {
      result.refs.push({ ...ref, line: ref.line + offset });
    }
  }
  return result;
}
