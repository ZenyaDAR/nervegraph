import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The viewer has no build step, so a control renamed in index.html and not in
// app.js fails silently at runtime: getElementById returns null and the
// listener is never attached. Cheap to catch here instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewer = (f: string) => readFileSync(path.join(__dirname, '..', 'viewer', f), 'utf8');

const APP_JS = viewer('app.js');
const INDEX = viewer('index.html');

test('every element app.js looks up exists in index.html', () => {
  const ids = new Set([...INDEX.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...APP_JS.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]));
  for (const id of used) {
    assert.ok(ids.has(id), `app.js reads #${id}, which index.html does not define`);
  }
});

test('the color-by control offers exactly the modes app.js implements', () => {
  const html = /<select id="color-by">([\s\S]*?)<\/select>/.exec(INDEX)?.[1] ?? '';
  const options = [...html.matchAll(/value="(\w+)"/g)].map(m => m[1]);
  const modes = /const COLOR_MODES = \[([^\]]+)\]/.exec(APP_JS)?.[1] ?? '';
  const implemented = [...modes.matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(options, implemented);
});
