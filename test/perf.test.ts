import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildGraph } from '../src/graph/build.ts';

// The project's own budget is "1500 files in under 3 seconds". That used to be
// a checkbox in a roadmap; here it is a test. The ceiling is deliberately loose
// (CI runners are slow and shared) — it is here to catch an accidental
// O(files × refs) pass, not to police a hundred milliseconds.

const FILES = 1500;
const BUDGET_MS = 20_000;

function bigProject(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nervegraph-perf-'));
  writeFileSync(path.join(root, 'package.json'), '{"name":"perf","main":"src/mod0.js"}');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  for (let i = 0; i < FILES; i++) {
    // Each module imports the next three, so edges scale with files and the
    // resolver, the cycle walk and the dedupe all get a real workload.
    const imports = [1, 2, 3]
      .map(d => `import { v${(i + d) % FILES} } from './mod${(i + d) % FILES}.js';`)
      .join('\n');
    writeFileSync(path.join(root, 'src', `mod${i}.js`), `${imports}\nexport const v${i} = ${i};\n`);
  }
  return root;
}

test(`scanning ${FILES} files stays inside the budget`, { timeout: 120_000 }, async () => {
  const root = bigProject();
  const started = Date.now();
  // --no-git: the fixture is not a repo, and the point is to time the scan.
  const graph = await buildGraph({ root, noGit: true });
  const elapsed = Date.now() - started;

  assert.equal(graph.stats.files, FILES + 1); // + package.json
  assert.ok(graph.stats.edges > FILES * 2, `expected a dense graph, got ${graph.stats.edges} edges`);
  assert.ok(elapsed < BUDGET_MS, `scan took ${elapsed}ms, budget is ${BUDGET_MS}ms`);
});
