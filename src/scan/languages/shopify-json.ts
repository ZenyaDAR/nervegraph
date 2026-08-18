import type { LanguageModule } from './types.ts';
import { scanShopifyJson } from '../scanners/shopify-json.ts';

// Only templates/*.json and sections/*.json carry structural refs
// (sections.*.type). Other JSON (config/, locales/) is a leaf node — see
// so it's deliberately not matched here.
export const shopifyJsonLanguage: LanguageModule = {
  id: 'shopify-json',
  matches: (id, ctx) =>
    ctx.profile === 'shopify' &&
    id.toLowerCase().endsWith('.json') &&
    (/^templates\//.test(id) || /^sections\/.*\.json$/.test(id)),
  scan: (file) => scanShopifyJson(file),
};
