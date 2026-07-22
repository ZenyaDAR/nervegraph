import type { RawRef, ScannerResult } from '../../graph/types.ts';

export function scanShopifyJson(file: { id: string; content: string }): ScannerResult {
  const refs: RawRef[] = [];
  let data: any;
  try {
    data = JSON.parse(stripLeadingComment(file.content));
  } catch {
    throw new Error('invalid json');
  }

  const sections = data?.sections;
  if (sections && typeof sections === 'object') {
    for (const [key, sec] of Object.entries<any>(sections)) {
      if (sec && typeof sec.type === 'string') {
        const line = findKeyLine(file.content, key, 'type', sec.type);
        refs.push({
          rel: 'template_section',
          target: sec.type,
          line,
          raw: truncate(`"type": "${sec.type}"`),
          literal: true,
        });
      }
    }
  }

  return { refs };
}

function truncate(s: string): string {
  return s.length > 120 ? s.slice(0, 120) : s;
}

function findKeyLine(text: string, sectionKey: string, prop: string, value: string): number {
  // Best-effort: find the `"type": "value"` occurrence nearest to the section key block.
  const keyIdx = text.indexOf(`"${sectionKey}"`);
  const searchFrom = keyIdx >= 0 ? keyIdx : 0;
  const propRe = new RegExp(`"${prop}"\\s*:\\s*"${escapeRegExp(value)}"`);
  const rest = text.slice(searchFrom);
  const m = propRe.exec(rest);
  if (!m) return 0;
  const idx = searchFrom + m.index;
  let line = 1;
  for (let i = 0; i < idx; i++) if (text[i] === '\n') line++;
  return line;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Shopify prepends an auto-generated "do not edit" /* ... */ comment to
// admin-managed template/section JSON — strip only that leading block so we
// don't need a full JSONC parser for the rest of the file.
function stripLeadingComment(text: string): string {
  const m = /^\s*\/\*[\s\S]*?\*\//.exec(text);
  return m ? text.slice(m[0].length) : text;
}
