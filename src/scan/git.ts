import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

// How often each file changed. In-degree alone says "many files point here";
// churn says "and it keeps moving" — together they are a far better answer to
// "which file should I be careful with" than either on its own.
//
// ponytail: commit counts only, no co-change pairs. Pairs need a second pass
// over every commit's file set and their value is unproven; add them when
// someone asks "what usually changes together with this".

const DEFAULT_COMMITS = 500;

/**
 * Commits touching each file, over the last `limit` commits. Returns an empty
 * map when this isn't a git repo, git isn't installed, or the call fails —
 * churn is a bonus signal, never a reason for a scan to fail.
 */
export function collectChurn(root: string, limit = DEFAULT_COMMITS): Map<string, number> {
  const churn = new Map<string, number>();
  if (!existsSync(path.join(root, '.git'))) return churn;

  let out: string;
  try {
    out = execFileSync(
      'git',
      ['log', `-n${limit}`, '--name-only', '--pretty=format:', '--no-renames', '--diff-filter=d'],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
  } catch {
    return churn;
  }

  for (const line of out.split('\n')) {
    const file = line.trim();
    if (!file) continue;
    churn.set(file, (churn.get(file) ?? 0) + 1);
  }
  return churn;
}

/**
 * The churn value a file has to reach to count as "hot": the 75th percentile
 * of the repo's own distribution, floored at 5 commits so a young repo doesn't
 * declare everything hot.
 */
export function hotThreshold(churn: Map<string, number>): number {
  const counts = [...churn.values()].sort((a, b) => a - b);
  if (!counts.length) return Infinity;
  const p75 = counts[Math.floor((counts.length - 1) * 0.75)];
  return Math.max(5, p75);
}
