import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRuby } from '../../src/scan/scanners/ruby.ts';

const pair = (content: string) =>
  scanRuby({ id: 'a.rb', content }).refs.map(r => [r.rel, r.target]);

test('require and require_relative are distinct relations', () => {
  assert.deepEqual(
    pair(`require 'json'\nrequire_relative 'helper'`),
    [['rb_require', 'json'], ['rb_require_relative', 'helper']],
  );
});

test('double quotes and parenthesised calls', () => {
  assert.deepEqual(
    pair(`require("set")\nrequire_relative("../lib/thing")`),
    [['rb_require', 'set'], ['rb_require_relative', '../lib/thing']],
  );
});

test('nested paths are preserved', () => {
  assert.deepEqual(pair(`require 'active_support/core_ext'`), [['rb_require', 'active_support/core_ext']]);
});

test('commented-out requires are ignored', () => {
  assert.deepEqual(pair(`# require 'ghost'\nrequire 'real'`), [['rb_require', 'real']]);
});

test('=begin/=end block comments are ignored', () => {
  assert.deepEqual(pair(`=begin\nrequire 'ghost'\n=end\nrequire 'real'`), [['rb_require', 'real']]);
});

test('a require built from an expression yields nothing rather than a wrong target', () => {
  assert.deepEqual(pair(`require File.join(__dir__, 'x')`), []);
});

test('line numbers survive a blanked block comment', () => {
  const refs = scanRuby({ id: 'a.rb', content: `=begin\nnote\n=end\nrequire 'real'` }).refs;
  assert.equal(refs[0].line, 4);
});
