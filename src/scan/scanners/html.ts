import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate, blank, isExternalUrl, customElementRefs } from './util.ts';

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
        refs.push({ rel: rule.rel, target, line, raw: truncate(full), literal: true });
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
