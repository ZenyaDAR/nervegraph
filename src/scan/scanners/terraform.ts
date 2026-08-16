import type { RawRef, ScannerResult } from '../../graph/types.ts';
import { lineAt, truncate } from './util.ts';

// Terraform's file graph is `module "x" { source = "./modules/y" }`: a local
// source is a directory of .tf files, anything else (a registry name, a git
// URL) is external infrastructure we don't have on disk.

const MODULE_RE = /\bmodule\b[^{]*\{[\s\S]*?\bsource\s*=\s*"([^"]+)"/g;
const COMMENT_RE = /^[ \t]*(?:#|\/\/).*$/gm;

export function scanTerraform(file: { id: string; content: string }): ScannerResult {
  const content = file.content.replace(COMMENT_RE, m => m.replace(/[^\n]/g, ' '));
  const refs: RawRef[] = [];

  for (const m of content.matchAll(MODULE_RE)) {
    const target = m[1];
    const local = target.startsWith('./') || target.startsWith('../');
    refs.push({
      rel: 'tf_module',
      target,
      line: lineAt(content, m.index),
      raw: truncate(`module source = "${target}"`),
      literal: local,
      ...(local ? {} : { value: 'external' }),
    });
  }

  return { refs };
}
