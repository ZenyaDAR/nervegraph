import path from 'node:path';
import type { LanguageModule } from './types.ts';
import { scanJavaScript } from '../scanners/javascript.ts';

const JS_EXT = new Set(['.js', '.mjs', '.ts', '.jsx', '.tsx']);

export const javascriptLanguage: LanguageModule = {
  id: 'javascript',
  matches: (id) => JS_EXT.has(path.extname(id).toLowerCase()),
  scan: (file) => scanJavaScript(file),
};
