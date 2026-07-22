import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRust } from '../../src/scan/scanners/rust.ts';

const targets = (id: string, content: string) =>
  scanRust({ id, content }).refs.map(r => r.target);

test('mod declarations in a crate root resolve alongside it', () => {
  assert.deepEqual(targets('src/lib.rs', `mod foo;\npub mod bar;`), ['foo', 'bar']);
});

test('a non-root module owns its own subdirectory', () => {
  assert.deepEqual(targets('src/parser.rs', `mod lexer;`), ['parser/lexer']);
});

test('mod.rs owns its directory, like a crate root', () => {
  assert.deepEqual(targets('src/parser/mod.rs', `mod lexer;`), ['lexer']);
});

test('pub(crate) and other visibility modifiers are handled', () => {
  assert.deepEqual(targets('src/main.rs', `pub(crate) mod a;\npub(super) mod b;`), ['a', 'b']);
});

test('an inline module body is not a file reference', () => {
  assert.deepEqual(targets('src/lib.rs', `mod tests {\n    fn t() {}\n}`), []);
});

test('use statements produce no refs — the mod graph already covers the files', () => {
  assert.deepEqual(targets('src/lib.rs', `use std::collections::HashMap;\nuse crate::foo::Bar;`), []);
});

test('commented-out mod declarations are ignored', () => {
  assert.deepEqual(targets('src/lib.rs', `// mod ghost;\n/* mod also_ghost; */\nmod real;`), ['real']);
});

test('line numbers survive blanked comments', () => {
  const refs = scanRust({ id: 'src/lib.rs', content: `/* a\nb */\nmod real;` }).refs;
  assert.equal(refs[0].line, 3);
});
