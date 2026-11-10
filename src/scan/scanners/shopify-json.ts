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
        const { line, index } = findKeyLine(file.content, key, 'type', sec.type, 0);
        refs.push({
          rel: 'template_section',
          target: sec.type,
          line,
          raw: truncate(`"type": "${sec.type}"`),
          literal: true,
        });
        blockRefs(sec.blocks, Math.max(index, 0));
      }
    }
  }

  // `sections.*.blocks.*.type`, nested `blocks` included. A type may name a
  // theme block (blocks/<type>.liquid) or a block defined inside the section's
  // own schema — only the resolver can tell, so these carry value
  // 'theme_block' and resolve.ts drops the ones with no file behind them.
  // `@app`/`@theme` are placeholders and `shopify://apps/...` is an app block.
  function blockRefs(blocks: unknown, from: number) {
    if (!blocks || typeof blocks !== 'object') return;
    for (const [key, block] of Object.entries<any>(blocks)) {
      if (!block || typeof block.type !== 'string') continue;
      const type: string = block.type;
      const { line, index } = findKeyLine(file.content, key, 'type', type, from);
      if (!type.startsWith('@') && !type.startsWith('shopify://')) {
        refs.push({
          rel: 'content_for',
          target: type,
          line,
          raw: truncate(`"type": "${type}"`),
          literal: true,
          value: 'theme_block',
        });
      }
      blockRefs(block.blocks, Math.max(index, from));
    }
  }

  return { refs };
}

function truncate(s: string): string {
  return s.length > 120 ? s.slice(0, 120) : s;
}

function findKeyLine(text: string, key: string, prop: string, value: string, from: number): { line: number; index: number } {
  // Best-effort: find the `"type": "value"` occurrence nearest after the key,
  // starting at the enclosing object's position so repeated block ids in
  // different sections don't all point at the first one.
  const keyIdx = text.indexOf(`"${key}"`, from);
  const searchFrom = keyIdx >= 0 ? keyIdx : from;
  const propRe = new RegExp(`"${prop}"\\s*:\\s*"${escapeRegExp(value)}"`);
  const rest = text.slice(searchFrom);
  const m = propRe.exec(rest);
  if (!m) return { line: 0, index: -1 };
  const idx = searchFrom + m.index;
  let line = 1;
  for (let i = 0; i < idx; i++) if (text[i] === '\n') line++;
  return { line, index: keyIdx >= 0 ? keyIdx : idx };
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
