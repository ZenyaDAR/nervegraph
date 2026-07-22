import type { RelType } from '../types.ts';
import type { Profile } from '../../scan/profile.ts';
import type { RelResolver } from './types.ts';
import { genericResolvers } from './generic.ts';
import { languageResolvers } from './languages.ts';
import { shopifyResolvers } from './shopify.ts';

export type { RelResolver, ResolveContext, ResolvedTarget } from './types.ts';

// Adding a new relation type (from a new or existing language scanner) means
// adding one entry here — resolve.ts never needs to change.
//
// findResolver takes the first entry matching (rel, profile), so two entries
// may share a rel only if their `profiles` are disjoint.
const RESOLVERS: RelResolver[] = [...genericResolvers, ...languageResolvers, ...shopifyResolvers];

export function findResolver(rel: RelType, profile: Profile): RelResolver | undefined {
  return RESOLVERS.find(r => r.rel === rel && (!r.profiles || r.profiles.includes(profile)));
}
