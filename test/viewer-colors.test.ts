import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NODE_TYPES, REL_TYPES } from '../src/graph/types.ts';

// viewer/app.js is plain browser JS with no build step and no exports, so it
// can't be imported here. Reading the color tables as text is enough to catch
// the failure that actually happens: adding a node type and forgetting to give
// it a color, which silently renders it in the "unknown" grey.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(path.join(__dirname, '..', 'viewer', 'app.js'), 'utf8');

function table(name: string): string {
  const start = APP_JS.indexOf(`const ${name} = {`);
  assert.ok(start >= 0, `${name} not found in viewer/app.js`);
  const end = APP_JS.indexOf('\n  };', start);
  assert.ok(end > start, `could not find the end of ${name}`);
  return APP_JS.slice(start, end);
}

function keysIn(block: string, mode: 'dark' | 'light'): Set<string> {
  const modeStart = block.indexOf(`${mode}: {`);
  const modeEnd = block.indexOf('},', modeStart);
  const body = block.slice(modeStart, modeEnd);
  return new Set([...body.matchAll(/(\w+)\s*:\s*'#/g)].map(m => m[1]));
}

for (const mode of ['dark', 'light'] as const) {
  test(`every NodeType has a ${mode}-mode color`, () => {
    const defined = keysIn(table('TYPE_COLOR'), mode);
    for (const t of NODE_TYPES) {
      assert.ok(defined.has(t), `node type "${t}" has no ${mode} color in viewer/app.js`);
    }
  });

  test(`every RelType has a ${mode}-mode line color`, () => {
    const defined = keysIn(table('REL_COLOR'), mode);
    for (const r of REL_TYPES) {
      assert.ok(defined.has(r), `rel type "${r}" has no ${mode} color in viewer/app.js`);
    }
  });

  test(`no stale color entry survives a removed type (${mode})`, () => {
    const nodeKeys = keysIn(table('TYPE_COLOR'), mode);
    for (const k of nodeKeys) {
      assert.ok((NODE_TYPES as readonly string[]).includes(k), `viewer defines a color for unknown node type "${k}"`);
    }
  });
}

test('COLOR_SCHEME.md documents every node type', () => {
  const doc = readFileSync(path.join(__dirname, '..', 'COLOR_SCHEME.md'), 'utf8');
  for (const t of NODE_TYPES) {
    assert.ok(doc.includes(`\`${t}\``), `COLOR_SCHEME.md does not mention node type "${t}"`);
  }
});

test('COLOR_SCHEME.md documents every relation type', () => {
  const doc = readFileSync(path.join(__dirname, '..', 'COLOR_SCHEME.md'), 'utf8');
  for (const r of REL_TYPES) {
    assert.ok(doc.includes(`\`${r}\``), `COLOR_SCHEME.md does not mention rel type "${r}"`);
  }
});
