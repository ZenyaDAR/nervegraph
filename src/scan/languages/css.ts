import path from 'node:path';
import type { LanguageModule } from './types.ts';
import { scanCss } from '../scanners/css.ts';

const CSS_EXT = new Set(['.css', '.scss']);

export const cssLanguage: LanguageModule = {
  id: 'css',
  matches: (id) => CSS_EXT.has(path.extname(id).toLowerCase()),
  scan: (file) => scanCss(file),
};
