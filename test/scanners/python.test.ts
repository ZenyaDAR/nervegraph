import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanPython } from '../../src/scan/scanners/python.ts';

const targets = (content: string) => scanPython({ id: 'a.py', content }).refs.map(r => r.target);

test('plain and dotted imports', () => {
  assert.deepEqual(targets(`import os\nimport a.b.c`), ['os', 'a.b.c']);
});

test('aliased and comma-separated imports', () => {
  assert.deepEqual(targets(`import numpy as np, pandas as pd`), ['numpy', 'pandas']);
});

test('from X import Y yields the submodule candidate', () => {
  assert.deepEqual(targets(`from pkg import mod`), ['pkg.mod']);
});

test('from X import a, b yields one candidate each', () => {
  assert.deepEqual(targets(`from pkg import a, b as c`), ['pkg.a', 'pkg.b']);
});

test('parenthesised import lists', () => {
  assert.deepEqual(targets(`from pkg import (a, b)`), ['pkg.a', 'pkg.b']);
});

test('star import targets the module itself', () => {
  assert.deepEqual(targets(`from pkg.sub import *`), ['pkg.sub']);
});

test('relative imports keep their leading dots for the resolver', () => {
  assert.deepEqual(
    targets(`from . import views\nfrom .models import User\nfrom ..shared import x`),
    ['.views', '.models.User', '..shared.x'],
  );
});

test('comments and trailing comments are ignored', () => {
  assert.deepEqual(targets(`# import ghost\nimport real  # noqa`), ['real']);
});

test('indented imports inside a function are found', () => {
  assert.deepEqual(targets(`def f():\n    import lazy_mod`), ['lazy_mod']);
});

test('line numbers are 1-based and accurate', () => {
  const refs = scanPython({ id: 'a.py', content: `x = 1\n\nimport os` }).refs;
  assert.equal(refs[0].line, 3);
});

test('a word merely containing "import" is not an import', () => {
  assert.deepEqual(targets(`important = 1\nreimport()`), []);
});
