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
const APP_CSS = viewer('app.css');

test('every element app.js looks up exists in index.html', () => {
  const ids = new Set([...INDEX.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
  const used = new Set([...APP_JS.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]));
  for (const id of used) {
    assert.ok(ids.has(id), `app.js reads #${id}, which index.html does not define`);
  }
});

// #help and #issues ship with the hidden attribute set, but both declare their
// own display in app.css, which beats the user agent's [hidden] rule — the help
// card and the issues panel covered the graph on every page load until the
// override below existed.
test('an element with a display rule of its own still obeys [hidden]', () => {
  const overridden = /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(APP_CSS);
  if (overridden) return;
  const hiddenIds = [...INDEX.matchAll(/id="([^"]+)"[^>]*\shidden\b/g)].map(m => m[1]);
  for (const id of hiddenIds) {
    const block = new RegExp(`#${id}\\s*\\{([^}]*)\\}`).exec(APP_CSS)?.[1] ?? '';
    assert.ok(!/display:/.test(block), `#${id} sets display, so [hidden] needs the !important override in app.css`);
  }
});

test('the color-by control offers exactly the modes app.js implements', () => {
  const html = /<select id="color-by">([\s\S]*?)<\/select>/.exec(INDEX)?.[1] ?? '';
  const options = [...html.matchAll(/value="(\w+)"/g)].map(m => m[1]);
  const modes = /const COLOR_MODES = \[([^\]]+)\]/.exec(APP_JS)?.[1] ?? '';
  const implemented = [...modes.matchAll(/'(\w+)'/g)].map(m => m[1]);
  assert.deepEqual(options, implemented);
});
