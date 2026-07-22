import type { RelType } from '../types.ts';
import type { Profile } from '../../scan/profile.ts';

export interface ResolveContext {
  profile: Profile;
  fileExists: (id: string) => boolean;
  defaultLocale?: string; // e.g. 'locales/en.default.json'
}

export type ResolvedTarget = { id: string; missing: boolean } | 'external';

/**
 * Resolves one RelType's literal target string to a node id. Registered per
 * (rel, profile) pair in resolvers/index.ts — the resolution unit is the
 * relation type, not the language that produced it, since two different
 * scanners can emit the same rel (e.g. both a future language and CSS could
 * emit `css_import`) and must resolve identically.
 */
export interface RelResolver {
  rel: RelType;
  /** Omit to apply regardless of project profile. */
  profiles?: Profile[];
  resolve(target: string, fromDir: string, ctx: ResolveContext): ResolvedTarget;
}
