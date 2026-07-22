import type { LanguageModule, LanguageContext } from './types.ts';
import { liquidLanguage } from './liquid.ts';
import { shopifyJsonLanguage } from './shopify-json.ts';
import { javascriptLanguage } from './javascript.ts';
import { cssLanguage } from './css.ts';

export type { LanguageModule, LanguageContext } from './types.ts';

// Adding a new language: write scanners/<lang>.ts (pure string -> RawRef[],
// see docs/EXTENDING.md), wrap it in a LanguageModule here, and add it to
// this array. If it introduces new RelTypes, register their resolution in
// graph/resolvers/. Nothing else in build.ts or resolve.ts needs to change.
const LANGUAGES: LanguageModule[] = [
  liquidLanguage,
  shopifyJsonLanguage,
  javascriptLanguage,
  cssLanguage,
];

export function findLanguage(fileId: string, ctx: LanguageContext): LanguageModule | undefined {
  return LANGUAGES.find(l => l.matches(fileId, ctx));
}
