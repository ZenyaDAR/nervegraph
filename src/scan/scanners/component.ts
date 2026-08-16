import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate } from './util.ts';
import { scanHtml } from './html.ts';
import { scanJavaScript } from './javascript.ts';

// Single-file components (.vue, .svelte, .astro) are three languages in one
// file, and each part already has a scanner:
//   template  -> the HTML scanner (src attributes, class="…")
//   <script>  -> the JavaScript scanner (imports of other components)
//   <style>   -> @use/@import and url(), matched here rather than through
//               postcss, because a `lang="scss"` block with unfinished nesting
//               would throw and cost the file *all* of its refs.
// Before this, .vue/.svelte/.astro weren't even read: they became opaque leaf
// nodes with no edges at all, which hid the whole component tree of a modern
// frontend.

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
const STYLE_IMPORT_RE = /@(?:import|use|forward)\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;
const STYLE_URL_RE = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;

/** Astro front matter: the `---` fenced block at the top holds real imports. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function scanComponent(file: { id: string; content: string }): ScannerResult {
  const content = file.content;
  const refs: RawRef[] = [];

  // The markup part. scanHtml only reacts to reference-carrying tags, so the
  // component's own custom elements are ignored and `<script src>` still works.
  const markup = scanHtml(file);
  refs.push(...markup.refs);

  const embedded: { body: string; start: number }[] = [];

  const fm = FRONTMATTER_RE.exec(content);
  if (fm) embedded.push({ body: fm[1], start: content.indexOf(fm[1]) });

  for (const m of content.matchAll(SCRIPT_RE)) {
    // A `<script src>` is already an edge from the HTML pass; its body is empty.
    if (/\bsrc\s*=/.test(m[1])) continue;
    embedded.push({ body: m[2], start: m.index + m[0].indexOf(m[2]) });
  }

  for (const { body, start } of embedded) {
    const offset = lineAt(content, start) - 1;
    for (const ref of scanJavaScript({ id: file.id, content: body }).refs) {
      refs.push({ ...ref, line: ref.line + offset });
    }
  }

  for (const s of content.matchAll(STYLE_RE)) {
    const body = s[1];
    const offset = lineAt(content, s.index + s[0].indexOf(body)) - 1;
    for (const [re, rel] of [[STYLE_IMPORT_RE, 'css_import'], [STYLE_URL_RE, 'asset']] as const) {
      for (const m of body.matchAll(re)) {
        const target = m[1];
        if (target.startsWith('data:')) continue;
        const line = lineAt(body, m.index) + offset;
        const external = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target);
        refs.push({ rel, target, line, raw: truncate(m[0]), literal: !external, ...(external ? { value: 'external' } : {}) });
      }
    }
  }

  return { refs, classes: markup.classes };
}
