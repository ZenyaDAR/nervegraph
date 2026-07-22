import path from 'node:path';
import type { RawRef, GraphEdge, UnresolvedRef } from './types.ts';
import { findResolver, type ResolveContext } from './resolvers/index.ts';

export type { ResolveContext } from './resolvers/index.ts';

export interface ResolveOutcome {
  edges: GraphEdge[];
  unresolved: UnresolvedRef[];
  missingTargets: Set<string>; // ids referenced but not on disk
}

export function resolveRefs(fromId: string, refs: RawRef[], ctx: ResolveContext): ResolveOutcome {
  const edges: GraphEdge[] = [];
  const unresolved: UnresolvedRef[] = [];
  const missingTargets = new Set<string>();
  const fromDir = path.posix.dirname(fromId);

  for (const ref of refs) {
    if (!ref.literal) {
      unresolved.push({
        from: fromId,
        line: ref.line,
        rel: ref.rel,
        raw: ref.raw,
        reason: ref.value === 'concatenated' ? 'concatenated' : ref.value === 'external' ? 'external' : 'dynamic',
        hint: hintFor(ref),
      });
      continue;
    }

    if (ref.value === 'external') {
      unresolved.push({ from: fromId, line: ref.line, rel: ref.rel, raw: ref.raw, reason: 'external', hint: 'external URL' });
      continue;
    }

    const resolver = findResolver(ref.rel, ctx.profile);
    const resolved = resolver ? resolver.resolve(ref.target, fromDir, ctx) : 'external';

    if (resolved === 'external') {
      unresolved.push({ from: fromId, line: ref.line, rel: ref.rel, raw: ref.raw, reason: 'external', hint: 'bare import / npm package, not a project file' });
      continue;
    }

    if (resolved.missing) missingTargets.add(resolved.id);
    edges.push({ from: fromId, to: resolved.id, rel: ref.rel, line: ref.line, raw: ref.raw, ...(ref.value && ref.value !== 'dynamic' && ref.value !== 'concatenated' && ref.value !== 'external' ? { value: ref.value } : {}) });
  }

  return { edges, unresolved, missingTargets };
}

function hintFor(ref: RawRef): string {
  if (ref.value === 'concatenated') return 'string is built via filters (append/prepend)';
  return 'name comes from a variable or expression';
}
