import type { LanguageModule } from './types.ts';
import { scanLiquid } from '../scanners/liquid.ts';

export const liquidLanguage: LanguageModule = {
  id: 'liquid',
  matches: (id) => id.toLowerCase().endsWith('.liquid'),
  scan: (file) => scanLiquid(file),
};
